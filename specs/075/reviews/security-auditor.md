# Security audit for spec 075

Scope: missed-order audit-log parity. The security-sensitive surface is the new
SECURITY DEFINER RPC `public.record_missed_orders_for_day(p_date date)`
([supabase/migrations/20260530000000_record_missed_orders_rpc.sql](../../../supabase/migrations/20260530000000_record_missed_orders_rpc.sql))
invoked by a `pg_cron` schedule and a one-shot 28-day backfill loop, writing to
the existing `audit_log` table. The frontend half is i18n catalog + tone-map
strings only — no auth surface — so the security review concentrates on the BE.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:201` — the
  RPC returns `v_inserted` (the count of rows the migration inserted into
  `audit_log` during a single call). When the daily cron runs, the count is
  what the schedule body discards; when a `service_role` bearer reruns the RPC
  (defense-in-depth callsite, not used today), the integer return value is the
  number of new rows. The count is not sensitive on its own — it's bounded by
  the caller's own schedule rows — and the RLS surface on `audit_log` was not
  changed. Flagging only as a follow-up note: if a future "rerun for date"
  admin button is added, the call should go through `callEdgeFunction` /
  `supabase.rpc(...)` like other writes so error handling is consistent. No
  change required in this spec.

## Detailed checks against the prompt's eight gates

### 1. `SECURITY DEFINER` + `search_path` (line-level confirmation)

PASS. The function is declared
`SECURITY DEFINER` with `SET search_path = public, pg_temp` AT THE FUNCTION
LEVEL (per the architect's design § "API contract"):

  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:131` —
    `security definer`
  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:132` —
    `set search_path = public, pg_temp`
  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:133` —
    `set lc_time = 'C'`

All three are attached to the function declaration (before the `as $$` body
opener at line 134), not as `SET LOCAL` statements inside the body. This is
the canonical search-path-hijack-defense shape; an attacker who can create
a `audit_log` table in a schema that precedes `public` cannot trick the RPC
into writing to the wrong table because `search_path` is locked to
`public, pg_temp` for the duration of any call. Identical posture to spec
050's `demote_profile_to_user`
([supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:61](../../../supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql)).

The `set lc_time = 'C'` is the architect's defense-in-depth lock against a
GUC-flip silently changing `to_char(p_date, 'FMDay')` output. Not a security
issue in the classic sense but a correctness lock that prevents an admin
silently dropping all future misses by changing `lc_time` in `postgresql.conf`
— worth recording.

### 2. Grant lockdown

PASS. All four required pieces are present and exact:

  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:224-225`
    — `revoke execute on function public.record_missed_orders_for_day(date)
    from public, anon, authenticated;` — explicit, not relying on Postgres
    defaults (Postgres grants `EXECUTE` to `PUBLIC` by default on every new
    function, so an explicit `REVOKE FROM PUBLIC` is required, and the
    explicit `anon`/`authenticated` revoke is belt-and-braces against an
    interpretation that PostgREST roles don't inherit from `PUBLIC` in some
    edge cases — they do, but the explicit list is the safe shape).
  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:226-227`
    — `grant execute on function public.record_missed_orders_for_day(date)
    to postgres, service_role;` — ONLY these two roles. No `anon`, no
    `authenticated`. Cleaner than spec 050's
    `demote_profile_to_user` which had to grant to `authenticated` (because
    it's session-driven); this RPC has zero session callers (cron + migration
    backfill only), so the tighter grant set is correct.

The pgTAP arm B
([supabase/tests/missed_order_audit_rpc.test.sql:81-97](../../../supabase/tests/missed_order_audit_rpc.test.sql))
explicitly verifies all four conditions in one composite assertion: anon and
authenticated return `has_function_privilege(... 'EXECUTE') = false`, postgres
and service_role return `true`, AND `pg_proc.prosecdef = true`. This is the
spec-045 catalog-query pattern (NOT the `set local role anon` segfaulting
pattern). The arm pins the grant lockdown against future drift — if a careless
future migration accidentally `GRANT EXECUTE ... TO PUBLIC`, this arm fails.

### 3. Input validation

PASS. The RPC accepts a single `p_date date` argument and Postgres's type
system enforces date validity at the PostgREST → SQL boundary (anything that
can't parse as `date` is rejected before the function body runs).
Additionally:

  - `supabase/migrations/20260530000000_record_missed_orders_rpc.sql:141-145`
    — defense-in-depth explicit null-check (raises `P0001 'p_date is required'`
    rather than silently treating null as no-op). This is correct: a
    misconfigured cron passing NULL would surface a visible error rather than
    quietly producing zero rows.
  - Future-date handling: if `p_date` is set to a future date, the
    `not exists (select ... from purchase_orders ...)` predicate would be
    trivially satisfied (no purchase orders for the future), so the RPC would
    insert audit_log rows for "missed" orders that haven't been due yet. This
    is harmless data-wise (the dedupe predicate would also prevent
    re-inserts) but slightly noisy. The daily cron body at line 252-254
    computes `((now() at time zone 'UTC') - interval '1 day')::date` which
    can never be a future date, so the realistic exposure is via a manual
    `service_role` call. Not a security issue, but flagged as an
    architect-side note above. **Not a finding.**
  - NULL date handling inside the inserted row's `detail`: confirmed at
    line 165-166 the detail string is built from
    `to_char(p_date, 'YYYY-MM-DD')` after the line 141-145 null-refusal, so
    no path can write a row with a NULL date embedded in the detail string.

### 4. `audit_log` RLS impact

PASS. The RPC writes to `audit_log` via SECURITY DEFINER, bypassing the
`store_member_insert_audit_log` INSERT policy
([supabase/migrations/20260504173035_per_store_rls_hardening.sql:167-172](../../../supabase/migrations/20260504173035_per_store_rls_hardening.sql)).
This is intentional (a trusted system actor writing system-attributable rows;
identical pattern to spec 050's `demote_profile_to_user`). The grant lockdown
(see check 2) prevents any non-system caller from invoking the RPC, so the
SECURITY DEFINER bypass can only be triggered by `postgres` (cron + migration)
or `service_role` (no current callsite).

Read-side surface is unchanged: the new rows are visible to operators only
through the existing `store_member_read_audit_log` SELECT policy
([supabase/migrations/20260504173035_per_store_rls_hardening.sql:160-165](../../../supabase/migrations/20260504173035_per_store_rls_hardening.sql)),
which gates on `auth_can_see_store(store_id)`. Verified at
`supabase/migrations/20260530000000_record_missed_orders_rpc.sql:162` that
the inserted `store_id` is sourced from `order_schedule.store_id`, which is
always non-null per the `order_schedule (store_id ... not null)` schema —
**no orphan rows with `store_id = NULL`** can be created by this RPC. (NULL
store_id rows are visible only to admins per the SELECT policy, but the RPC's
SELECT only emits non-NULL store_id rows, so the surface doesn't widen.)

CLAUDE.md "Permissive RLS policies are ORed" lint: N/A — no new policy added.

### 5. Cron security

PASS. The `cron.schedule()` body
([supabase/migrations/20260530000000_record_missed_orders_rpc.sql:248-256](../../../supabase/migrations/20260530000000_record_missed_orders_rpc.sql))
is a static SQL literal inside a `$cron$ ... $cron$` dollar-quote. No string
concatenation of caller input, no `format(...)` with `%s` interpolations of
external values, no `EXECUTE ... USING` constructs. The body computes
`((now() at time zone 'UTC') - interval '1 day')::date` inline at execution
time using pg_cron's own `now()` and a literal date arithmetic expression —
nothing external can influence the schedule body's contents.

The cron job is registered as `record-missed-orders-daily` via
`perform cron.schedule(...)` inside a DO block running as the migration role
(`postgres`). pg_cron in Supabase runs jobs as the role that scheduled them,
so the job will execute under `postgres` — the same role that has explicit
`GRANT EXECUTE` to the RPC (check 2). Consistent posture.

The "if exists ... unschedule" guard at lines 244-246 is the spec 026
re-application-safety pattern (matches `20260424211733_security_fixes.sql:161-163`)
— makes the migration idempotent even if the cron job already exists from a
prior apply.

### 6. 28-day backfill loop

PASS. The backfill loop at
`supabase/migrations/20260530000000_record_missed_orders_rpc.sql:274-293`
runs at migration apply time inside a `DO $$` block as the migration's
executing role (postgres). Migration files run inside a single implicit
transaction in Supabase's migration applier — if any of the 28 iterations
errors, the whole migration aborts and rolls back. There's no "half-populated
table" failure mode because the apply is transactional.

Idempotency on retry is enforced by the architect's `lower(detail) =
lower(<computed detail>)` dedupe predicate at lines 187-195 (which the
architect explicitly corrected from the PM-spec's
`(store_id, action, item_ref, created_at::date)` key — see the file header
DEDUPE-KEY block at lines 45-62 explaining the backfill-rerun hole that
fix closes). pgTAP arm E2 at lines 263-281 pins this end-to-end by calling
the RPC three times for the same `p_date` and asserting exactly one row in
`audit_log`. Same-transaction retries are caught.

Backfill worst-case row count: 2 stores × 5 vendors × 28 days = ~280 rows.
Trivial volume. No DoS surface, no out-of-resources risk.

### 7. SQL injection / Bobby Tables

PASS. The `detail` string is built from `vendor.name` (from the canonical
`vendors` table when `vendor_id` is set, falling back to
`order_schedule.vendor_name`). The composition uses **plpgsql string
concatenation** (`||`) inside an INSERT ... SELECT, with vendor names passed
as values into the SELECT's bound parameters (Postgres treats them as VALUES,
not as SQL fragments). This is **not** dynamic SQL — there's no `EXECUTE`,
no `format(...)`, no string-based query construction.

A malicious admin who can insert into `order_schedule` or `vendors` could
place a vendor name like `'); DROP TABLE audit_log; --` and have that string
land in the `detail` column — but the string is **stored as data**, not
executed as SQL. The `detail` column has no special semantics. The dedupe
predicate at lines 187-195 does `lower(al.detail) = lower(<computed string>)`
which is again a value comparison, not a query parse. No injection surface.

Note on the canonical authorization boundary: only admins (via the `vendors`
table's RLS) can write `vendors.name` and only admins can write
`order_schedule.vendor_name`. An admin sneaking SQL fragments into a vendor
name would be tampering with their own brand's audit log — they already have
admin RLS, so this isn't an escalation. The injection surface is theoretical
zero either way.

### 8. `audit_log` exposure via RLS read policy

PASS. The existing `store_member_read_audit_log` SELECT policy gates rows by
`auth_can_see_store(store_id)`. The new RPC sets `store_id` from
`order_schedule.store_id` (a NOT NULL FK to `stores`), so every inserted row
has a real store_id and is only visible to that store's members per
`auth_can_see_store(store_id)`. **No cross-store leak path.** Verified at
`supabase/migrations/20260530000000_record_missed_orders_rpc.sql:162`.

A store member with access to multiple stores will see all their stores'
missed-order rows in the AuditLogSection feed — exactly the spec's intent,
not a leak.

## CLAUDE.md edge-function pattern parity (gate 9)

PASS. The RPC is system-invoked (cron + migration backfill), not user-invoked.
Spec patterns that don't apply here:

  - **Last-of-role guard** (`assert_not_last_of_role`) — N/A, not a
    role-change or deletion op. Architect's design correctly notes this in
    spec body §"Project-specific notes / CLAUDE.md 'last-of-role guard' /
    'self-guard' rules: N/A".
  - **`caller.id != target.id` self-guard** — N/A, the RPC takes a date,
    not a `target_user_id`. No self-action to guard.
  - **Edge function `verify_jwt` / `ADMIN_ROLES` set** — N/A, no edge
    function in this spec.
  - **HTML-body `escapeHtml`** — N/A, no Resend/HTML surface.

The grant lockdown (check 2) ensures there is **no path where a user can
invoke this RPC directly**. anon/authenticated lack EXECUTE; the only callers
are pg_cron (running as postgres) and the migration backfill (running as
postgres). A future "rerun for date" admin button would need to go through
service_role (already granted, defense-in-depth) or a future migration would
need to add `authenticated` — and that future migration would be the right
place to add a `caller.id IS NOT NULL` check, an `auth_is_privileged()` gate,
and a self-guard if appropriate.

## Dependencies

`npm audit --audit-level=high`:

- **17 vulnerabilities (16 moderate, 1 high)**. The high-severity vuln is
  `@xmldom/xmldom <=0.8.12` (uncontrolled recursion in XML serialization →
  DoS; plus three additional XML-injection vectors). This is **pre-existing**
  drift — not introduced by spec 075 (which adds zero new dependencies).
  `package.json` was NOT modified in this spec.
- The moderate vulnerabilities (`brace-expansion`, `dompurify`, `postcss`,
  `uuid`, `ws`) are all transitive through the Expo SDK 54 toolchain.
  `npm audit fix --force` would require an Expo major upgrade (56.0.8) —
  a separate, scope-defined upgrade spec, not a spec 075 concern.
- **No new CVE counts attributable to spec 075.** Surface is sql-only.

CVE delta vs. baseline: **0 new vulnerabilities introduced.** The audit is
green for this spec's contribution.

## Threat-model summary

  - Search-path hijack: locked at function-level. Pass.
  - Privilege escalation via RPC: anon + authenticated lack EXECUTE. Pass.
  - SQL injection through vendor names: no dynamic SQL surface. Pass.
  - Cross-store audit_log leak: `store_id` always non-NULL, RLS read policy
    unchanged. Pass.
  - Backfill DoS: ~280 rows max, transactional. Pass.
  - Self-invocation by non-system caller: grant lockdown blocks. Pass.
  - Cron body injection / token leak: schedule body is a static SQL literal,
    no service-role token or external string in the body. Pass.
  - Search-path-locked RLS bypass: SECURITY DEFINER intentionally bypasses
    RLS for the system-write; the only callers are the postgres-owned cron
    and the postgres-owned migration backfill, both of which are
    trust-anchor roles. Pass.

## Verdict

**APPROVE.** No Critical, High, or Medium findings. The migration is the
right shape, the pgTAP arm B pins the grant lockdown, and the search_path /
`SECURITY DEFINER` / explicit grant patterns all match the documented
canonical shapes (spec 050's `demote_profile_to_user`). The architect's
correction of the dedupe predicate from the PM's
`(store_id, action, item_ref, created_at::date)` key to
`lower(detail) = lower(<computed detail>)` is verifiably in the migration
([lines 187-195](../../../supabase/migrations/20260530000000_record_missed_orders_rpc.sql))
and pinned by pgTAP arm E2.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low.
payload_paths:
  - specs/075/reviews/security-auditor.md
