## Security audit for spec 190 (po-number-sequence)

Scope: `supabase/migrations/20261109140000_po_number_sequence.sql`,
`supabase/tests/generate_po_number_sequence.test.sql`,
`supabase/tests/generate_po_number_malformed_guard.test.sql`,
`supabase/tests/report_run_variance_formula.test.sql` (comment only),
`scripts/smoke-po-number-concurrency.sh`. I checked the local DB catalog
read-only (`supabase_db_imr-inventory`, migration applied). I did not touch prod.

Verdict: **no Critical, no High.** The SECURITY DEFINER change is narrow and
correctly hardened. No caller-controlled value reaches the privileged code. It is
an improvement over today's INVOKER `max()` body on both correctness and
availability. The one Medium is a residual abuse path that predates this spec.
The spec now bounds it and makes it clear itself, but does not close it.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- `supabase/migrations/20261109140000_po_number_sequence.sql:162-173` (the
  skip loop), together with the unchanged policies
  `store_member_insert_purchase_orders` / `store_member_update_purchase_orders`
  (`20260504173035_per_store_rls_hardening.sql:184-200`). **Any store member can
  still make other tenants' PO inserts fail by squatting on PO numbers.**
  - **What the catalog shows locally:**
    - `authenticated` has INSERT and UPDATE on `purchase_orders.po_number` (column privileges).
    - The insert policy's WITH CHECK is only `auth_can_see_store(store_id)`.
    - The update policy lets a member rewrite `po_number` on any PO in a store they can see.
  - **Who can do it:** any authenticated user with a `user_stores` row, including
    staff accounts that never legitimately create POs. That user can:
    1. Learn the counter's position by inserting one PO with a NULL `po_number`
       into their own store and reading the number back. The fresh row can then
       be deleted, because `purchase_orders_restrict_delete_aged` allows deleting
       rows less than a day old.
    2. Send one PostgREST bulk insert (array body) of 100×K rows with explicit
       numbers `PO-<next>` to `PO-<next+100K-1>`. They can also UPDATE their own
       store's POs onto those numbers.
  - **Effect:** numbering is global across brands, so the next K generated inserts
    **in any brand** hit the 100-attempt bound and fail with `54000` ("Draft not
    created"). Each failure moves the sequence 100 numbers further, so the attack
    clears itself. The attacker can repeat it, and can delete the squatting rows
    within a day, which removes the evidence in the table apart from the gaps.
  - **A smaller variant:** an explicit insert of exactly the next number, held in
    an open transaction, makes a concurrent generated insert block on the unique
    index and then get `23505` (D-7 residual). Via PostgREST the hold is limited
    by the request or statement timeout.
  - **Not a regression.** Under the old INVOKER `max()` body the same actor could
    block another brand **permanently** with a handful of rows. The other
    brand's `max()` can't see the squatted rows, so it keeps generating the same
    taken number. So this spec turns a permanent cross-tenant outage into a
    bounded, self-clearing one. It does not block deploy.
  - **Fix (follow-up spec; the spec lists "validating explicit `po_number`" as
    out of scope):** add a BEFORE INSERT OR UPDATE OF `po_number` guard that
    rejects a caller-supplied non-NULL or changed `po_number` when
    `current_user in ('anon','authenticated')`. Use the `P0001` refusal-string
    convention, e.g. `'po_number is server-assigned'`. Table-level INSERT/UPDATE
    grants can't be narrowed per column without re-granting column lists, so a
    trigger is the practical shape. `postgres` and `service_role` fixtures and
    hand inserts keep working. This also removes the need for the skip loop's
    RLS-blind probe to defend against client-supplied numbers.

### Low

- `supabase/migrations/20261109140000_po_number_sequence.sql:170-172`. **The
  `54000` error goes back to the client with internal detail.**
  - The message includes a concrete taken PO number (`last tried PO-N`), and the
    `hint` names `public.purchase_orders_po_number_seq` and tells the reader to
    `setval()` it.
  - PostgREST returns `message` and `hint` to the browser. `notifyBackendError`
    (`src/store/useStore.ts:58-63`) shows `message` in the toast.
  - It is not sensitive: the sequence name isn't a secret, and PO numbers are
    already enumerable through the unique constraint's `23505` detail. But the
    hint is operator guidance sent to end users.
  - Optional fix: shorten the hint, or log the candidate with `raise log` before
    the exception and keep the client message generic.
- Spec 190 D-4 point 2a and D-11 #1 (by design). **New cross-brand volume
  signal.**
  - Any store member who creates two POs learns how many POs were created across
    the whole table, in every brand, between them.
  - Under the old RLS-scoped `max()`, a non-super-admin's number only reflected
    POs they could see. So this is new cross-tenant information, though it is
    low sensitivity.
  - The owner accepted global numbering (Q1). Recorded so a future multi-tenant
    privacy review can find it; no change needed now.
- `specs/190-po-number-sequence.md` D-9 (prod-apply checklist). **Three
  verification gaps on the DEFINER path's assumptions:**
  1. D-9 checks the function owner and `relforcerowsecurity`, but not
     `purchase_orders`' owner on prod, or `rolbypassrls` for `postgres`. DP-1
     pins both, but only on local/CI. If prod's table owner differs and
     `postgres` lacks BYPASSRLS, the probe silently becomes RLS-filtered again.
     That is a correctness regression (defect 1 returns as `23505`), not a leak.
     Add the DP-1 query to D-9.
  2. The "proacl/relacl contains no `anon=` or `authenticated=` entry" check
     would miss a PUBLIC grant, which is written `=X/postgres`. Also assert that
     no entry starts with `=`. Locally `proacl` is
     `{postgres=X/postgres,service_role=X/postgres}`, so the migration itself is
     correct.
  3. Also assert that the sequence owner is `postgres`. If the MCP session ran as
     a different role, `OWNED BY` would fail loudly anyway, because the table and
     sequence owners must match.
- `specs/190-po-number-sequence.md` D-11 #4 and the sequence comment at
  `20261109140000_po_number_sequence.sql:186`. **A factual claim in the spec is
  wrong, and the actual problem predates this spec and is out of scope.**
  - D-11 #4 says "anon and authenticated have no TRUNCATE (spec 097)". Locally,
    `purchase_orders.relacl` is `authenticated=arwdDxtm/postgres` (`D` =
    TRUNCATE), and 47 of 51 `public` tables grant TRUNCATE to `authenticated`.
  - Spec 097's no-TRUNCATE list is additive, so it never removed the image
    default's TRUNCATE. The default ACL for `postgres` in `public` still includes
    `D`.
  - **The sequence-reset vector this spec worries about is still closed:**
    - `TRUNCATE ... RESTART IDENTITY` requires *ownership* of the owned
      sequence, which client roles don't have.
    - PostgREST, Realtime and pg_graphql expose no TRUNCATE verb.
    - `profiles` correctly has no TRUNCATE (spec 041).
  - Correct the D-11 #4 rationale. Open a separate spec to check prod's ACL and
    revoke TRUNCATE from `anon` and `authenticated` on `public` tables, with a
    pgTAP probe for future tables (`public_grants_explicit.test.sql` doesn't
    cover it today).
- `specs/190-po-number-sequence.md` "Prod apply → Rollback" and D-10.
  **"Rolling back is safe" is only true while every generated number is below
  1000.**
  - Once any `PO-1000` or higher exists, the old body's `lpad(n, 3)` truncation
    collides with an existing number on every insert. Rolling back would then
    restore a permanent outage, not just the four defects.
  - Prod is at 19, so this doesn't matter today. Qualify the rollback note.

### Verified clean (no finding)

- **What a caller can influence through the DEFINER body: nothing.**
  - The trigger is gated `WHEN (new.po_number IS NULL)` (`set_po_number`,
    verified in `pg_trigger`) and reads no other `NEW` field.
  - The privileged `exists` probe is keyed only on `nextval()` output (`:163-167`),
    so the trigger is not an oracle for caller-chosen values. The pre-existing
    unique-constraint `23505` remains the stronger (and harmless) existence
    signal.
  - The body writes only `NEW.po_number` and the sequence.
- **search_path.**
  - `proconfig = {search_path=public}` on both functions (AC-12 holds).
  - `anon`, `authenticated` and `service_role` have no CREATE on schema `public`
    (checked), so nothing can be planted there.
  - `pg_catalog` is searched implicitly first, so `lpad`, `length`, `nextval`,
    `||` and `=` can't be shadowed.
  - Every relation and function reference is schema-qualified, including the
    `nextval` regclass literal and `public.format_po_number`, so implicit
    `pg_temp` relation lookup is not reachable either.
- **Grants against spec 097 default privileges.**
  - Sequence `relacl = {postgres=rwU/postgres,service_role=rwU/postgres}`. The
    `postgres`-in-`public` default ACL for `S` would otherwise have given
    `anon` and `authenticated` `rwU`, and the revoke at `:105` removed it.
  - Both functions have `proacl = {postgres=X/postgres,service_role=X/postgres}`
    (revokes at `:145`, `:182`). `PUBLIC` is included in the revoke lists.
  - DP-2 and DP-3 use `has_*_privilege`, which also counts PUBLIC.
  - `service_role` keeping ALL is consistent with its trust level.
- **Not callable.** `generate_po_number()` returns trigger (`0A000` if called
  directly). `format_po_number(bigint)` is in PostgREST's schema cache but
  returns `42501` to client roles. It is pure and IMMUTABLE either way, so it has
  no side effects. AC-15 is met.
- **RLS bypass is intended and pinned.** Locally `purchase_orders` is owned by
  `postgres` and has `relforcerowsecurity = f`. DP-1 pins both.
  - No policy was added, dropped or altered.
  - The permissive-policy lint is unaffected.
  - Read access is unchanged: callers still only *see* rows under
    `auth_can_see_store()`.
- **Resource bounds.** The loop is capped at 100 index probes per insert. The
  bigint `NO CYCLE` sequence can't realistically be exhausted by abuse, because
  each squatted number costs the attacker one row.
- **Migration safety.**
  - It runs in one transaction with `lock_timeout = '5s'`.
  - The plain `create sequence` fails loudly if re-applied.
  - The seed casts through `numeric`, and an oversized hand-typed max fails the
    `::bigint` and rolls the whole migration back instead of mis-seeding.
  - There is no destructive DDL. CI's `db-migrations-applied.yml` gate only
    checks drift, not safety, so I am stating explicitly: nothing here drops or
    rewrites data.
- **Tests and smoke.**
  - pgTAP fixtures are hermetic (`begin; … rollback;`). The empty-string auth
    token columns follow the project memory rule. There are no secrets.
  - The smoke script talks only to the local container via `docker exec`, has no
    user-supplied input in its interpolated SQL, and cleans up by fixed ids.
- **Out of the threat surface.** No edge function, `config.toml`, client, `db.ts`,
  store or realtime publication changes. The `send-order-failure-email` consumer
  already escapes `po_number`.

### Dependencies

`package.json` is not part of spec 190's change set. The working tree has an
unrelated `test:smoke` script-line edit from another in-flight spec, with no
dependency change. `npm audit` was skipped.
