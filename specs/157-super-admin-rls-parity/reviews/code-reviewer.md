# Code review for spec 157

Scope reviewed: `supabase/migrations/20260809000000_super_admin_policy_parity.sql`,
`supabase/tests/super_admin_policy_parity.test.sql`,
`src/screens/DBInspectorScreen.tsx`, `src/screens/__tests__/DBInspectorScreen.test.tsx`.
Cross-referenced against `supabase/migrations/20260504173035_per_store_rls_hardening.sql`,
`supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql`,
`supabase/migrations/20260517020000_admin_rpcs_use_privileged.sql`, and
`supabase/tests/permissive_policy_lint.test.sql`.

Targeted verification requested by the dispatcher — all five checked and clean:

- **Seven policy swaps, byte-for-byte apart from the predicate.** Diffed each
  `create policy` in the new migration against its source (`20260504173035:160-181`
  for the four `audit_log` policies, `20260507015244:37-48` for the three
  `ingredient_categories` policies). Policy names (including exact quoted-identifier
  spelling), `permissive` kind, implicit `to public` role list, and the
  `store_id is not null and auth_can_see_store(store_id)` OR-arms are unchanged.
  Only `public.auth_is_admin()` → `public.auth_is_privileged()` changed, in every
  occurrence.
- **Probe RPC change is additive-only.** Diffed the new
  `admin_db_inspector_probe()` body against `20260517020000_admin_rpcs_use_privileged.sql:14-135`
  line-by-line. Signature, `security definer`, `set search_path`, the
  `auth_is_privileged()` entry guard, and the `schema` / `counts` / `recipe_groups`
  / `prep_groups` blocks are byte-identical. The only delta is two new keys
  (`is_privileged`, `is_super_admin`) inside the `auth` `jsonb_build_object`;
  `is_admin` is kept.
- **`classifyAuthBanner`'s five ordered rules (absence-before-false).**
  `DBInspectorScreen.tsx:168-174` checks null/undefined, then
  `typeof is_privileged !== 'boolean'`, then `is_privileged === false`, then
  `is_admin === true`, in that order, before falling through to
  `privileged-super-admin`. The deploy-skew arm (missing fields) is correctly
  evaluated before the `is_privileged === false` arm, so an old-probe payload
  (fields absent) lands in `'unknown'`, not `'not-privileged'`. Jest arm 4 in
  the test file exercises exactly this ordering.
- **Banned banner strings are gone.** `ALL your CRUD` and `You are NOT admin
  per the JWT` do not appear anywhere in `DBInspectorScreen.tsx` (grep-verified).
  The only surviving `auth_is_admin` literal is inside the
  `privileged-super-admin` copy, as an explanation of why the token-only check
  reports `false` — matches the AC-12 exception exactly, and is pinned by a
  jest arm that asserts every *other* branch excludes the substring.
- **Migration idempotency/convergence.** Every `create policy` is preceded by
  a matching `drop policy if exists`; the function is `create or replace`;
  `comment on function` / `comment on policy` overwrite on re-application.
  `begin; … commit;` wraps the whole file, matching the
  `20260528000000_actor_fk_cascade_audit.sql` precedent the header cites.

### Critical

None.

### Should-fix

None.

### Nits

- `supabase/migrations/20260809000000_super_admin_policy_parity.sql:207` and
  `:216` — the `comment on policy` text on `admin_update_audit_log` /
  `admin_delete_audit_log` contains `cleanupOldRecords'' global unfiltered
  retention purge`. The doubled single-quote is valid SQL-escaping and will
  render as a literal apostrophe (`cleanupOldRecords' global unfiltered...`),
  but that reads as a dangling possessive (missing `s`, e.g.
  `cleanupOldRecords()'s global unfiltered retention purge`). Cosmetic only —
  the comment is metadata, not logic — but worth a one-character fix next
  time this migration is touched.
- `supabase/migrations/20260809000000_super_admin_policy_parity.sql:113-163` —
  the operational rollback block reproduces the seven pre-change `create
  policy` statements and a pointer to revert the probe RPC, but has no
  corresponding step to clear/restore the `comment on function
  public.auth_is_admin()` metadata added at `:254-268`. Not functionally
  significant (the comment is documentation, not a grant or predicate), but a
  literal paste-revert per the header's own framing would leave spec-157's
  comment stranded on a function whose behavior was otherwise rolled back.
- `src/screens/__tests__/DBInspectorScreen.test.tsx:51` — the fixture builder
  is named `auth()`, which is generic enough that it could be mistaken for an
  import of the real `auth` module if someone skims the file quickly. A name
  like `buildAuth()` or `probeAuth()` would read a bit more unambiguously at
  the call sites (`auth({ is_privileged: true, is_admin: true })`). Very
  minor — the file is short and the usage is locally clear.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 3 Nits.
payload_paths:
  - specs/157-super-admin-rls-parity/reviews/code-reviewer.md
