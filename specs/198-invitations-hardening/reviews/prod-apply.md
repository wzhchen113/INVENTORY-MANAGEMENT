# Spec 198 prod apply (2026-11-20)

Project `ebwnovzzkwhsdxkpyjka`, applied through the Supabase MCP on the owner's go-ahead in chat. The order follows spec §10 and release-proposal item 11.

## Before the apply (read-only)

| Check | Result |
|---|---|
| P-1 pending invitations | none |
| P-2 / P-3 | 0 pending, 0 NULL expiry, 4 rows in total, all used |
| P-8 policies | INSERT and UPDATE use spec 191's `auth_profile_is_privileged()` shape. SELECT and DELETE are `auth_is_privileged()` with roles `public` (195-H1, as expected) |
| P-9 ACLs | `get_pending_invitation(text)`: PUBLIC, anon, authenticated, service_role. `register_invited_profile()`, `consume_invitation`, `assert_not_last_of_role`: postgres, authenticated, service_role |
| P-12 | includes `20261109191000` (191) and `20261109195000`, but not `20261110120000` |
| Q-1 | pgcrypto in `extensions`; authenticated has USAGE and EXECUTE on `gen_random_bytes` |
| Q-2 | sha256 hex length 64 |
| Q-4 | `demote_profile_to_user(uuid)`, `register_invited_profile()`. Equals local apart from the signature this spec replaces |
| Q-6 | no FKs reference `invitations` |
| Q-7 | authenticated has SELECT, INSERT, UPDATE, DELETE |

Rollback inputs: the pre-apply bodies of `get_pending_invitation(text)` and `register_invited_profile()` on prod match the migration sources that `rollback.sql` recreates verbatim. Pre-apply body md5s: `get_pending_invitation` `604ebacc926cc3b041256c9438119f66`, `register_invited_profile()` `1dcec3194b4735b49b66f101a633b2cf`, `consume_invitation` `13ee616699b637b6d46ebe5fc4bdfa94`, `assert_not_last_of_role` `0638c51b89305a6c109a146f2feb7f9a`.

Owner dashboard checks (sign-up, SMTP, Send Email hook, `RESEND_API_KEY`) were not done here because SQL can't read them. This spec changes none of them.

## Apply

1. `execute_sql` with the committed migration body verbatim. The only addition was the `schema_migrations` insert for `20261110120000` just before the final `commit;`. No `'198:'` raise fired.
2. `notify pgrst, 'reload schema';`

## Verification (prod equals local)

- **Functions** (normalized `prosrc` md5, prosecdef, owner postgres):
  - `assert_invitation_provenance()` `613b45f5…` f
  - `check_invitation_code(text,text)` `57d0f31f…` t
  - `create_invitation(…)` `5b47cb61…` f
  - `register_invited_profile(text)` `86ade3db…` t
  - `consume_invitation` and `assert_not_last_of_role` bodies are unchanged.
  - `get_pending_invitation` and the zero-argument `register_invited_profile` are gone.
- **Policies:** all four are `{authenticated}`. SELECT and DELETE `864eb7d8…`, INSERT with_check `648ee063…`, UPDATE `bfe1da65…` / `8dc14413…`.
- **Privileges:** the step-5 matrix is as designed. anon can call only `check_invitation_code`. authenticated has lost `consume_invitation` and `assert_invitation_provenance`. No PUBLIC entry on any of the six functions.
- **Schema:** the `invited_by` and `code_hash` columns, `invitations_code_hash_key`, `invitations_code_hash_format`, and `invitations_provenance_guard` (enabled `O`) are all present. 0 pending rows. `schema_migrations` has `20261110120000`.

## Edge function

`send-invite-email` was deployed through the MCP as v28 with `verify_jwt: true`. Its source is the committed `index.ts`. A POST with no bearer returns 401. The admin-bearer 400 `inviteCode required` probe was not run, because no prod admin token is available to the agent.
