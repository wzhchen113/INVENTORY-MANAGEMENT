## Security audit for spec 196 (po-number-server-assigned)

Scope: `supabase/migrations/20261109200000_po_number_server_assigned.sql`,
`supabase/tests/po_number_server_assigned.test.sql`, and the unstaged AC-16 edit to
`supabase/tests/report_run_variance_formula.test.sql`. I ran read-only catalog
queries against the local DB (`supabase_db_imr-inventory`, migration applied). I
did not touch prod and did not run any write, including rolled-back ones.

**Verdict: no Critical, no High.** The migration closes the spec 190 security
Medium (client roles squatting explicit PO numbers ahead of the global sequence).
I found no client-reachable path that can still set or change `po_number`. Two
Low items and one informational note follow.

### What I checked, and the result

**1. Guard function and trigger (local catalog)**

- `purchase_orders_po_number_guard()`:
  - `prosecdef = f`, `proconfig = {search_path=public}`, owner `postgres`.
  - `proacl = {postgres=X/postgres,service_role=X/postgres}`. There is no
    `anon=`, `authenticated=` or PUBLIC (`=`) entry.
- The body (migration L91-116) calls no function and reads no table, GUC or
  claim. The role test is the SQL keyword `current_user`. That keyword is the
  role running the statement only because the function is INVOKER. The comment
  at L29-32 and the AC-13/AC-19 arms both pin this.
- The wiring check (L95-98) fails closed before the role check.
- Refusal: `P0001 'po_number is server-assigned'`, with no DETAIL or HINT
  (L109, L112). Nothing internal leaks, unlike spec 190's `54000` hint.
- `purchase_orders_po_number_guard_trg`:
  - `tgenabled O`, `tgtype 23` (BEFORE ROW INSERT|UPDATE).
  - No column list and no `WHEN`, so an UPDATE that leaves `po_number` out of
    its SET list still goes through the OLD-vs-NEW comparison.

**2. Trigger ordering**

Local listing in C order: `notify_purchase_order`(21),
`purchase_orders_lock_created_at_trg`(19, `{11}`),
`purchase_orders_lock_store_id_trg`(19, `{2}`),
`purchase_orders_no_return_to_draft_trg`(19, `{8}`),
`purchase_orders_po_number_guard_trg`(23), `set_po_number`(7, WHEN).

- **INSERT:** the guard is the first BEFORE ROW INSERT trigger. It sees the
  caller's proposed `NEW` before `set_po_number` fills it.
- **UPDATE:** the guard fires last among the BEFORE UPDATE triggers.
  - None of the spec 177/194 triggers before it writes `po_number`.
  - `set_po_number` is INSERT-only (`tgtype 7`), so no trigger after the guard
    can change `po_number` on UPDATE.
  - An UPDATE that also breaks a 177/194 rule gets that trigger's 42501. That is
    still a refusal, so nothing is lost.

**3. Write paths that could still reach `po_number`. All are closed or out of reach:**

- **PostgREST INSERT, bulk INSERT, PATCH (any app role, including super_admin):**
  every one runs as `authenticated` or `anon`, so the guard applies. Bulk
  statements are atomic: the first explicit row aborts the whole statement.
- **PostgREST upsert (`resolution=merge-duplicates`, `ON CONFLICT DO UPDATE`):**
  - The INSERT branch runs the BEFORE INSERT triggers on the proposed row, so a
    non-NULL `po_number` is refused there.
  - The DO UPDATE branch runs the BEFORE UPDATE guard against the existing row.
    If the payload names `po_number`, the SET is `excluded.po_number`. When the
    client sent NULL, that value is the freshly generated number, which differs
    from the old one, so the update is refused. When the client sent the
    existing value, the INSERT branch has already refused it.
  - Result: an upsert can never change an existing row's number. No client
    upserts `purchase_orders` today.
- **SECURITY DEFINER functions:** I listed every function whose body mentions
  `purchase_orders`.
  - DEFINER writers: `auto_receive_due_purchase_orders`,
    `record_vendor_order_attempt`, `generate_po_number`.
  - INVOKER writers: `receive_purchase_order`, `cancel_purchase_order`,
    `close_short_purchase_order`.
  - Every UPDATE body I extracted sets only `status`, `received_*` or
    `receive_client_uuid`. Only `generate_po_number` writes `po_number`.
  - The only DEFINER function that uses dynamic `EXECUTE` is `staff_submit_eod`,
    and it does not touch `purchase_orders`.
  - So the owner's accepted DEFINER residual has nothing exploitable in it
    today, as far as the repo/local catalog shows. See Low #1 for prod.
- **Views, rules, inheritance:** none. No view depends on `purchase_orders`, the
  table has no rules, and it has no child tables. So there is no auto-updatable
  view owned by `postgres` that could route a write around RLS or the guard.
- **pg_graphql (enabled, 1.5.11):** `graphql_public.graphql` and
  `graphql.resolve` are SECURITY INVOKER. Mutations run as the caller's role,
  so the guard applies.
- **Realtime:** read-only for this table (`supabase_realtime` publication). No
  publication change, so the realtime restart step correctly does not apply.
- **Edge functions:**
  - `send-po-email/index.ts:204-208` writes only `status: "sent"`, as
    `service_role`.
  - `send-order-failure-email` only reads `po_number`, and it is escaped
    (`index.ts:169`).
  - `eod-reminder-cron` only reads.
  - No service-role function copies request-body fields into `purchase_orders`,
    so no client can launder a number through the owner path.
- **Client code:**
  - `src/lib/db.ts`, `extension/src/lib/imrClient.ts:104` and
    `src/screens/staff/lib/receiving.ts:116` never send `po_number`.
  - `src/utils/usFoodsImport.ts:56` is a CSV header field and is never written
    to the DB.
- **Role escalation to get past `current_user`:**
  - `authenticator` can SET ROLE only to `anon`, `authenticated` and
    `service_role`.
  - No custom role inherits `authenticated` or `anon`.
  - No function's `proconfig` sets `role`, `session_authorization` or
    `session_replication_role`.
  - `pg_parameter_acl` is empty, so client roles cannot set
    `session_replication_role = replica` to skip triggers.
  - `anon` and `authenticated` have no CREATE on `public` and do not own the
    table, so they cannot ALTER, DISABLE TRIGGER or replace it.
  - The `custom_access_token` hook is not enabled in `supabase/config.toml`
    (L304, commented out), so the JWT `role` claim stays GoTrue-issued.
- **Column shape:** `po_number` is `text` with the deterministic `default`
  collation and no column DEFAULT, so `IS DISTINCT FROM` is a byte-exact
  comparison. A case-only or trailing-space rename cannot slip through. The
  unique index `purchase_orders_po_number_key` is unchanged.

**4. The INVOKER / `current_user` reasoning**

D-3 and D-5 are correct:

- In an INVOKER function, `current_user` is the role of the triggering
  statement.
- `SET search_path` in `proconfig` does not change it.
- Postgres checks EXECUTE on a trigger function only at `CREATE TRIGGER` time.
  So the revoke from `public`, `anon` and `authenticated` cannot stop the
  trigger firing, and the function cannot be called over `/rpc`.
- AC-11 proves that leftover claims under `postgres` are ignored. Since the body
  reads no claims, the guard cannot be spoofed by a crafted `request.jwt.claims`
  either.

**5. Tests**

- The refusal arms use `throws_ok(..., 'P0001', 'po_number is server-assigned')`,
  so a 42501 from RLS or from a 177/194 trigger cannot pass as the guard.
- Anti-vacuity `auth_can_see_store(S)` arms for the admin and super_admin
  callers are present.
- The AC-19 mutation record shows that each security-relevant property can fail:
  DEFINER flip, rename after `set_po_number`, widened role test, `anon` removed.
- The AC-16 edit removes the only authenticated-role explicit-number fixture.
  The rewritten comment is accurate.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **`specs/196-po-number-server-assigned.md` D-11 step 1 / D-5. The accepted DEFINER residual is only checked against the repo, not prod.**
  - D-5 bases "no RPC writes `po_number`" on a grep of `supabase/migrations/`.
    D-11 checks the guard's own catalog row and the trigger listing.
  - It never checks prod for a DEFINER function, view, rule or prod-only
    trigger that writes `purchase_orders`.
  - Project memory says dashboard drift has happened before. The
    `db-migrations-applied` gate only warns on prod-only history, and it cannot
    see functions created outside migrations.
  - Impact if such an object existed: a client-callable bypass of the guard,
    which reopens the spec 190 Medium. It is not a new privilege.
  - Fix: add one read-only pre-check to D-11 step 1 and compare it with local
    (expected locally: `auto_receive_due_purchase_orders`,
    `record_vendor_order_attempt` and `generate_po_number`, of which only the
    last matches `po_number`):
    ```sql
    select n.nspname||'.'||p.proname, p.prosecdef, p.prosrc ~* 'po_number' as writes_po_number
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and p.prosrc ~* 'purchase_orders'
       and n.nspname not in ('pg_catalog','information_schema');
    select count(*) from pg_rewrite r join pg_depend d on d.objid = r.oid
     where d.refobjid = 'public.purchase_orders'::regclass
       and r.ev_class <> 'public.purchase_orders'::regclass;   -- expect 0 (no views)
    ```
    STOP if any DEFINER row other than `generate_po_number` has
    `writes_po_number = t`, or if the view count is non-zero.
  - This changes the runbook text only, not the migration.

- **`supabase/migrations/20261109140000_po_number_sequence.sql` (spec 190's `set_po_number`), noted in spec 196 D-5 / D-13 #4. Unauthenticated callers can advance the global sequence.**
  - BEFORE ROW triggers run before RLS `WITH CHECK`. So an `anon` request using
    only the public publishable key, or any customer-PWA `authenticated` user
    with no store, can send bulk inserts with `po_number` omitted.
  - Those inserts are refused by `store_member_insert_purchase_orders`
    (`auth_can_see_store` is false), but only after the DEFINER
    `set_po_number` has already called `nextval()`.
  - `anon` holds INSERT on the table (`relacl anon=arwdDxtm/postgres`, spec 097).
    The policies have no `TO` clause.
  - Impact is cosmetic only:
    - Gaps cannot be "taken" numbers, so they can never cause `54000`. This spec
      correctly makes that the bound.
    - A persistent caller can inflate visible PO numbers across every brand.
  - D-5 mentions "an RLS-refused insert" but does not say that the caller can be
    completely unauthenticated.
  - Not introduced by this spec and not a blocker. Possible follow-up (owner
    decision, outside this spec's out-of-scope list): revoke
    INSERT/UPDATE/DELETE on `purchase_orders` from `anon`. No anon caller writes
    POs. An alternative is a guard arm that refuses every `anon` INSERT. Either
    way it should be recorded with the other spec 190 Low items.

### Informational (no action)

- The SECURITY DEFINER residual is correctly documented in the function comment
  (migration L131-134) and the header (L42-44). Any future DEFINER RPC that
  writes `purchase_orders.po_number` must be reviewed against it. That is the
  owner's accepted posture, not a finding.
- `service_role` keeps the spec 097 default EXECUTE on the guard. It is
  harmless: Postgres does not check EXECUTE when a trigger fires, and calling
  the function directly fails with `0A000`.

### Dependencies

`package.json` is not part of spec 196's `## Files changed`. Its working-tree diff
(from another session) changes only one `test:smoke` script line and no
dependency. I ran `npm audit --audit-level=high` anyway as a baseline: 46
advisories (1 critical `shell-quote`, 17 high, including `ws`, `node-forge`,
`dompurify` and the `@react-navigation/*` chain), all transitive or pre-existing
and none attributable to this spec. No dependency action for 196.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low.
payload_paths:
  - specs/196-po-number-server-assigned/reviews/security-auditor.md
