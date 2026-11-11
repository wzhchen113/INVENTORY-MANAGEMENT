# Spec 198: prod pre-checks (read-only)

Run by the main session on 2026-11-09 through the Supabase MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`. Read-only; nothing changed. Re-run before the apply.

| Query | Result |
|---|---|
| **P-1** pending invitations by brand | **None.** Every invitation on prod is used. |
| **P-2** expiry spread of pending rows | None (no pending rows). |
| **P-3** NULL `expires_at` | 0 of 4 rows; 4 rows in total, all `used = true`. |
| **P-4** pending invitations whose email already has an account | 0. |
| **P-5** duplicate pending per email | None. |
| **P-6** brand-less, store-less rows | None. |
| **P-7** table shape | Columns as in the repo: `id`, `email` (not null), `profile_id` (not null, no FK), `name`, `role` default `'user'`, `store_ids` default `'{}'`, `used` default false, `created_at`, `expires_at` default `now() + 48h` (nullable), `brand_id` (FK to brands, cascade), `username`. Constraints: pkey, `invitations_brand_id_fkey`, `invitations_username_format`. **No unique constraint or index on email**, so `invitations_email_key` (quoted in `InviteUserDrawer.test.tsx:358`) does not exist on prod. Indexes: pkey, `invitations_brand_id_idx` (partial). |
| **P-8** live policies | Four, all PERMISSIVE. INSERT and UPDATE (`to authenticated`) still use `auth_is_privileged()` + `auth_can_see_brand` + the store check (spec 164 shape; spec 191 isn't on prod). **SELECT and DELETE are `auth_is_privileged()` only, roles `public`**, confirming 195-H1 on prod. |
| **P-9** function ACLs | `assert_not_last_of_role(uuid, text)`: `postgres`, `authenticated`, `service_role`, with **no anon and no PUBLIC entry**. `consume_invitation(uuid, text)`: `postgres`, `authenticated`, `service_role`. `get_pending_invitation(text)`: PUBLIC, `anon`, `authenticated`, `service_role`. `register_invited_profile()`: `postgres`, `authenticated`, `service_role`. `service_role` has EXECUTE on `assert_not_last_of_role`. |
| **P-10** accounts without a profile | 0. |
| **P-11** autoconfirm proxy | 10 accounts, 0 unconfirmed, max confirmation lag over the last 90 days 0.08 s (5 recent sign-ups). Consistent with email confirmation **off**. The dashboard is authoritative. |
| **P-12** migrations on or after `20261109000000` | `20261109120000`, `20261109170000`. Specs 187, 191 and 195 are **not** on prod yet. |

## Readings

- **No live exposure today.** 195-H1 needs a pending invitation to steal, and prod has none. It becomes live the next time an admin sends an invite, so the fix should land before invites resume.
- **OQ-4 is moot** at today's counts: there are no pending invitations to clamp or re-invite. Re-check at apply time.
- **191-L3 is repo/local drift, not a prod hole.** Prod already denies anon and PUBLIC on `assert_not_last_of_role`; the local stack grants anon. A migration that revokes anon and PUBLIC changes nothing on prod and aligns the repo.
- **Spec 198 depends on 191** for `auth_profile_is_privileged()`. 191 isn't on prod yet.
