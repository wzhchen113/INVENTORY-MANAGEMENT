## Security audit for spec 170

Scope: `supabase/migrations/20261022000000_audit_log_rls_hardening.sql` (new, untracked),
`supabase/tests/audit_log_rls_hardening.test.sql` (new, untracked),
`supabase/tests/super_admin_policy_parity.test.sql` (unstaged amend), and `src/lib/db.ts`
`deleteStore` (unstaged one-line removal). No edge function, `config.toml`, or `package.json`
change.

### Method (local stack only; prod and Supabase MCP not touched)

- Live catalog reads on the local DB: `pg_policies`, RLS/FORCE flags, table grants, publication
  membership, FKs, triggers, every `public` function whose body references `audit_log`
  (definer flag, owner, EXECUTE grants), and views/rules that depend on the table.
- Two rolled-back psql probe scripts (`begin … rollback`), impersonating staff
  (`22222222-…`, JWT `user`), admin (`11111111-…`, JWT `admin`), super_admin (`33333333-…`
  promoted in-txn, JWT `user`), `anon`, and `service_role`. Writes were wrapped in a
  per-statement exception handler so each verb reports its own SQLSTATE and row count.
- Ran these pgTAP files directly; each is hermetic and rolls back. Results:
  - `audit_log_rls_hardening`: 45/45
  - `super_admin_policy_parity`: 20/20
  - `permissive_policy_lint`: 5/5
  - `actor_fk_cascade_audit`: 13/13
  - `staff_receiving_gate`: 45/45
  - `missed_order_audit_rpc`: 9/9
  - `cross_brand_copy`: 14/14

### Verified clean (the dispatch checklist)

| Check | Result | Evidence |
|---|---|---|
| Staff cannot read store-user rows | **Holds.** Staff got 0 rows when filtering on both store-user actions, and could still read an ordinary S1 row. Admin and super_admin read both rows. | Probe + pgTAP R-1..R-4. `anon` reads 0 rows. |
| Staff cannot forge `user_id` | **Holds.** These all fail with `42501` under `audit_log_restrict_insert_actor_is_caller` (migration `:123-130`): another profile's id, `NULL`, and other-store / store-less inserts (the last two fail on the permissive arm). | Probe + I-1/I-2 |
| Server-only actions cannot be inserted | **Holds for the exact strings.** Staff, admin, and super_admin are each refused with `42501` (`:108-115`). | Probe + I-4..I-15. A **lookalike** bypass exists; see L1. |
| Nobody can UPDATE | **Holds.** Staff, admin, and super_admin UPDATE all return 0 rows. `INSERT … ON CONFLICT DO UPDATE` as staff fails with `42501 (USING expression)`, so upsert is not an edit path either. | Probe + U-1/U-2, AL-5/AL-9. No UPDATE policy (S-2). |
| Fresh rows cannot be deleted | **Holds.** Admin and super_admin DELETE of a fresh row affect 0 rows. Staff deletes affect 0 rows, whether the row is old or their own fresh row. `anon` deletes affect 0 rows. | Probe + D-1/D-2/D-7 |
| Old rows deletable only in scope | **Holds.** Admin removed a 100-day S1 row. Admin could not remove a brand-B row or a store-less row (D-4/D-5). Super_admin removed an old row and an old store-less row (D-6). | Probe + D-3..D-6 |
| DEFINER RPCs, service role, and INVOKER PO RPCs still insert | **Holds.** W-1..W-6 all pass. W-2/W-3 call the service-role-only DEFINER RPCs from an RLS-subject role, so the owner-bypass arm is sharp. The service-role `'Store user created'` insert succeeds. S-7 pins the bypass precondition: owner = table owner, FORCE RLS off. | pgTAP + probe |
| Store-delete cascade | **Holds.** D-8 (superuser) passes. D-9 also passes: the admin-JWT store delete removes a fresh audit row even though the DELETE policy refuses it, which proves RI actions run outside RLS. | pgTAP |
| Realtime | `audit_log` is not in any publication (empty `pg_publication_tables`). No channel can leak store-user rows. | catalog |
| Hidden RLS-subject writers | None. The only references in `supabase/functions/` are in `manage-store-user` (service client). `src/screens/staff/` has none. In `src/`, the server-only action strings appear only in display maps. The live definers that reference `audit_log` match the architect's §2 table. The one extra definer, `preview_brand_cascade`, is super_admin-gated and returns counts only. `report_run_custom` is INVOKER, so RLS applies to it. | grep + catalog |
| Restrictive layer covers `anon` | Yes. All three restrictive policies have `roles = {public}`. | catalog |
| `deleteStore` change | Safe. The function has zero callers (architect §0), and the FK cascade covers the deleted line. Removing a call that now affects 0 rows hides no error. | `src/lib/db.ts:185` |
| Policy helpers | Uses `auth_is_privileged()`, `auth_can_see_store()`, and `auth_is_super_admin()`. No hand-rolled JWT parsing, and no `auth_is_admin` (LINT-1 stays 0). The permissive lint passes with no allowlist change. | migration `:141-151` |

Nothing in this change grants access that did not exist before. Every permissive predicate
touched is a strict subset of the one it replaces.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- **M1: any store member (staff) can pin undeletable rows to the top of the admin audit feed, with
  `created_at` forward-dated or `NULL` (architect gap F-170-1, extended). Spec 170 turns a
  REST-recoverable nuisance into one recoverable only through psql or MCP.**
  - **Where:**
    - `supabase/migrations/20261022000000_audit_log_rls_hardening.sql:123-130`: no INSERT
      policy constrains `created_at`.
    - `:146`: the age gate.
    - `src/lib/db.ts:2810-2818`: `fetchAuditLog` uses `order('created_at', desc).limit(100)`.
    - `created_at` is nullable (`20260405000759_init_schema.sql:204`).
  - **What I confirmed (rolled-back probes):**
    - Staff on S1 can insert a self-attributed ordinary row with `created_at = '2099-01-01'`.
      Admin and super_admin DELETE of that row both affect 0 rows.
    - Staff can also insert `created_at = NULL`. With `ORDER BY created_at DESC`, Postgres sorts
      NULLs **first**, so the NULL row was the top row of the S1 feed. A master-JWT DELETE left it
      in place.
    - A NULL-dated row is **never** API-deletable, because `NULL < now() - 90 days` is NULL. Only
      the store FK cascade or a superuser can remove it. A 2099 row is undeletable until 2189.
    - Backdating also works: staff inserted a self-attributed `'PO price change'` row dated
      30 days ago, which lands inside the historical timeline.
  - **Impact:**
    - 100 such inserts by a single staff member push every genuine event off the store's admin
      audit view (`limit 100`) indefinitely.
    - Before this spec, a privileged caller could remove them with one REST DELETE under the
      unscoped `admin_delete_audit_log`. Now nobody can through the API.
    - The age gate exists to make the "recent" window tamper-evident. Here it protects junk that
      the lowest-privileged principal planted.
  - **Why not High:**
    - The rows are self-attributed, since policy (c) forces `user_id = auth.uid()` for staff, so
      the actor is identified.
    - It exposes no data and escalates no privilege.
    - Recovery exists (operator psql / MCP `delete`).
    - Customer-PWA users have no `user_stores` grant and cannot reach it.
  - **Fix (recommended before or alongside the prod apply; one statement, no writer impact):**
    ```sql
    create policy "audit_log_restrict_insert_created_at_server_clock"
      on public.audit_log as restrictive for insert
      with check (created_at = now());
    ```
    - Defaults are applied before WITH CHECK, so omitted columns pass.
    - An explicit `NULL` evaluates to NULL and is rejected. A forward- or back-dated value is
      rejected.
    - No RLS-subject writer sets `created_at`:
      - `addAuditEvent` at `db.ts:2838-2845` omits it;
      - the three INVOKER PO RPCs insert only `(store_id, user_id, action, detail, item_ref,
        value)` (live body check);
      - DEFINER writers and service_role bypass RLS.
    - The pgTAP fixtures that age rows insert as `postgres`, which bypasses RLS, so they are
      unaffected.
    - Optionally add `alter table public.audit_log alter column created_at set not null` after
      checking `count(*) where created_at is null` = 0 on prod. That closes the NULL variant at
      the schema layer for service_role as well.
    - If the owner prefers to keep this out of spec 170, ship F-170-1 as the **next** migration.
      Do not leave it as an open-ended backlog item, because spec 170 is what removed the
      REST-side remediation.

### Low

- **L1: the server-only list (b) is an exact-string blocklist. Case, whitespace, and label-text
  variants bypass it, and the UI renders some variants identically to the genuine row.**
  (Architect gap: "staff self-attributed ordinary-action forgery"; rated **Low**.)
  - **Where:**
    - Migration `:113-114`.
    - `src/utils/formatAuditAction.ts:39`: unmapped actions fall back to
      `event.action.toLowerCase()`.
  - **Confirmed:** staff inserts of `'order missed'`, `'Store user created '` (trailing space),
    and `'set store user password'` all succeed.
    - In the `en` locale, `'order missed'` renders as "order missed", byte-identical to the
      genuine `enum.auditAction.orderMissed` label.
    - The label-text variant renders exactly as the real "set store user password" row.
    - The tone and category maps (`AuditLogSection.tsx:34-36,70-71`, `PhoneAuditLog.tsx:52-54`)
      are exact-match, so lookalikes lose the coloured tone and the `order`/`user` category.
    - In `es`/`zh-CN` the genuine row is translated and the lookalike shows lowercase English.
      Both differences help detection.
  - **Why Low:**
    - Staff lookalikes are self-attributed under policy (c).
    - Ordinary-action content forgery by staff (fake `'PO received'`, `'Waste log'`,
      `'User deleted'`, free-text `detail` such as "approved by <admin>") is inherent while those
      actions stay client- or INVOKER-written, and it is not attribution forgery.
    - A small but useful tell: genuine `'EOD entry'` / `'Waste log'` rows from the staff DEFINER
      RPCs carry `user_id = NULL`, and a staff-forged copy cannot.
  - **Fix (follow-up, pairs with F-170-3):**
    - Replace (b) with a positive allowlist of client-writable actions, for example
      `with check (action in ('EOD entry','Item edit',…,'PO received','PO price change',
      'PO closed short','PO cancelled'))`, or a `CHECK` / enum domain on `action`.
    - Either way, any non-canonical string is refused for every RLS-subject caller, not just the
      four exact ones.
    - Then move the PO RPC writes behind a DEFINER helper (F-170-3) so they can join the
      server-only side.

- **L2: privileged callers can attribute ordinary rows to any profile, including `NULL`. A `NULL`
  actor is indistinguishable from DEFINER "system" rows.** (Architect gap: "privileged cross-brand
  `user_id` attribution", F-170-4; rated **Low**.)
  - **Where:** migration `:128-129` (`or public.auth_is_privileged()`).
  - **Confirmed:**
    - An admin inserted `'PO auto-received'` with `user_id = NULL`, matching the shape of the
      genuine `auto_receive_due_purchase_orders` row: same action, empty actor.
    - An admin inserted `'User deleted'` attributed to the master's profile id.
    - Any existing profile id passes, cross-brand included; only the FK limits it to real
      profiles.
  - **Why Low:** it needs a privileged insider, and it is limited to stores the caller can already
    see. Owner decision 3 explicitly accepted it for the EOD on-behalf path
    (`useStore.ts:3049`).
  - **Fix (follow-up F-170-4):** a definer helper that admits these `user_id` values:
    - `NULL`;
    - `auth.uid()`;
    - a profile in the caller's brand;
    - any profile, for `auth_is_super_admin()`.

    Consider a CHECK or allowlist rule that refuses `NULL`-actor rows for the DEFINER-only
    action names (`'PO auto-received'`) once (b) becomes an allowlist.

- **L3: remaining privileged erase paths, by design but not stated in the spec's residual risk.**
  - **`audit_log_user_id_fkey ON DELETE SET NULL`** (`20260528000000_actor_fk_cascade_audit.sql:58-59`).
    Any caller who can delete a profile (brand admins, under the profiles DELETE policy)
    retroactively strips attribution from every audit row that profile wrote. Those rows then
    render with an empty actor, like system rows.
  - **Store / brand delete cascade** (D-9). A brand admin who deletes a store removes all of its
    audit rows, fresh ones included.

  Both are deliberate (spec 105-era actor cascade; brand delete cascade), and both are loud, since
  the store or user visibly disappears. They do mean that "nobody can erase a recent row through
  the API" is true **per row**, not per store or per actor.

  **Fix:** add one sentence to the spec's Risks so the release proposal and the owner see it. If
  the owner later wants a true append-only trail, the long-term options are snapshotting actor
  name/role into the row at insert time, or a separate archive table outside the cascade. No code
  change is needed in this spec.

- **L4: pre-existing. `anon` and `authenticated` hold `TRUNCATE` on `public.audit_log` (and 46
  other public tables), and TRUNCATE ignores RLS.**
  - **Live grants:** `anon` and `authenticated` both have
    `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`. The source is the
    `pg_default_acl` entries (`arwdDxtm` for `anon`/`authenticated`), which
    `20260618000000_public_grants_explicit.sql:147` adds to but never revokes.
  - **Reachability:** none today. PostgREST does not issue TRUNCATE, and `report_run_custom` is
    INVOKER and read-only. So this is defence-in-depth only, consistent with spec 041's Low rating
    for `user_stores`.
  - **Relevance:** it is the single privilege-layer verb that bypasses every spec 170 policy at
    once.
  - **Fix (optional fold-in, zero runtime impact, since no writer truncates):**
    ```sql
    revoke truncate on public.audit_log from anon, authenticated;
    ```
    Pin it with a `has_table_privilege('authenticated','public.audit_log','TRUNCATE') = false`
    arm. The broader 46-table sweep stays a separate spec, as 041 recommended. Also verify prod's
    grant state during the owner's prod pre-check, because I did not read prod.

- **L5 (informational, pre-existing, unchanged): store-less rows are visible to every privileged
  caller across brands.**
  - `store_member_read_audit_log`'s second arm, `store_id is null and auth_is_privileged()`, lets
    a brand-B admin read brand-A's `'catalog_copy'` rows (`detail` = target brand id).
  - Any admin can insert store-less rows that only super_admin can delete (probe confirmed admin
    store-less insert = OK).
  - The Cmd UI filters by `store_id` (`db.ts:2815`), so nothing renders it. Note it for the next
    `audit_log` visibility audit (spec Out-of-scope bullet 3). No action in this spec.

### Architect follow-up gaps: ratings summary

| Gap | Rating | Recommendation |
|---|---|---|
| F-170-1: client-settable `created_at` (forward-dating), plus the NULL variant found here | **Medium (M1)** | Restrictive `with check (created_at = now())`. Fold into 170 before the prod apply, or ship as the immediately-next migration. Spec 170 removed the REST remediation, so this should not sit in the backlog. |
| Staff self-attributed ordinary-action forgery, plus exact-string lookalikes of server-only actions | **Low (L1)** | Positive allowlist / CHECK on `action`, together with F-170-3 |
| Privileged cross-brand / NULL `user_id` attribution (F-170-4) | **Low (L2)** | Brand-scoped definer helper. Insider-only, accepted by owner decision 3. |

### Notes for the release-coordinator (non-security)

- The migration and the new pgTAP file are **untracked** (`??`). `src/lib/db.ts` and the
  parity test are unstaged. Spec 167/169 files are staged in the same index. Make sure the commit
  includes all four spec 170 files and nothing it should not.
- The architect's prod sequencing (§12: apply via MCP, then push) still applies. If M1's policy
  or L4's revoke is folded in, the §12 S-1 post-check list grows by one RESTRICTIVE INSERT row
  (seven rows), and S-6's comment count becomes 5.

### Dependencies

No `package.json` change in spec 170, so `npm audit` was skipped.

## Delta re-review (fix pass) — 2026-10-22

Scope: the unstaged fix-pass `git diff` on top of the staged original:
- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`: new policy (f), `audit_log_restrict_insert_created_at_now`, a RESTRICTIVE INSERT `with check (created_at = now())` at `:167-178`, plus header and rollback updates at `:29-38` and `:74`.
- `supabase/tests/audit_log_rls_hardening.test.sql`: C-1..C-8 and D-10, `plan(54)`.
- `supabase/tests/super_admin_policy_parity.test.sql`: the AL-8 fixture is now aged.
- `src/lib/db.ts:179`: comment only.
- The spec: decision 9, AC-22/AC-23, F-170-5/6, and the L3 Risks sentence.

No edge function, `config.toml`, or `package.json` change.

### Method (local stack only; prod and Supabase MCP not touched)

- **Catalog check.** The live local `pg_policies` matches the migration file: 7 policies, and (f) reads `(created_at = now())`. RLS is enabled and FORCE is off. `audit_log` has no user triggers, so no BEFORE trigger can rewrite `created_at` after the check.
- **psql probe.** One `begin … rollback` script ran each statement through an exception-trapping helper. It impersonated:
  - staff (`22222222-…`, JWT `user`);
  - admin (`11111111-…`, JWT `admin`);
  - super_admin (`33333333-…`, promoted in-txn with `brand_id = null`);
  - `anon`;
  - `service_role`.
- **Real PostgREST requests.** I signed in as `manager@local.test` and `admin@local.test` on `127.0.0.1:54321` and sent requests to `/rest/v1/audit_log`. Rejected requests commit nothing. To test the success path without committing, I used a 2-row insert with `Accept: application/vnd.pgrst.object+json`. PostgREST runs the INSERT (RLS included), then returns 406 PGRST116 and rolls the transaction back.
  - **Disclosure:** one probe (`?columns=` that leaves out `created_at`, single row, singular Accept) committed 1 row per principal, 2 local rows in total. Both rows had a server-clock `created_at`, which is the expected result. I deleted exactly those two ids as postgres right away. The local `audit_log` count is back to 4.
- **pgTAP, run directly** (each file is hermetic). All pass, 0 failures:

  | File | Passed |
  |---|---|
  | `audit_log_rls_hardening` | 54/54 |
  | `super_admin_policy_parity` | 20/20 |
  | `permissive_policy_lint` | 5/5 |
  | `actor_fk_cascade_audit` | 13/13 |
  | `staff_receiving_gate` | 45/45 |
  | `missed_order_audit_rpc` | 9/9 |
  | `cross_brand_copy` | 14/14 |
  | `auto_receive_due_purchase_orders` | 24/24 |
  | `cost_on_receipt` | 55/55 |
  | `report_run_custom` | 14/14 |
  | `staff_role_eod_rls` | 11/11 |

### M1: CLOSED

Every case below was run as staff (S1, `user_id` = self, ordinary action). Each case named with a role (admin, super_admin, anon, service_role) was also run as that principal.

| Case | Result |
|---|---|
| Explicit `'2099-01-01'` / `now() - 30 days` / `NULL` | `42501`, refused by `audit_log_restrict_insert_created_at_now` (staff, admin, super_admin; admin also tried `now() - 91 days` and `'2000-01-01'`) |
| `'infinity'` / `'-infinity'` / `'tomorrow'` / `clock_timestamp()` / `now() + 1µs` | `42501` (`'infinity'` would have been the worst pin: it sorts first and is never `< now() - 90d`) |
| Admin store-less future, super_admin store-less `NULL` | `42501` (privileged callers get no exemption) |
| `created_at` omitted / `DEFAULT` keyword | OK. The stored value `= now()` was `true` for all 7 staff rows in the txn |
| `'now'` literal | OK. It resolves to the transaction start, the same instant as the default. Harmless |
| Multi-row `VALUES` (good + future) / `INSERT … SELECT` of 3 future rows | `42501`, and the whole statement fails. Good + good: OK, 2 rows |
| `ON CONFLICT DO NOTHING` with a future value, both a new id and an existing id | `42501`. WITH CHECK runs on the proposed row before conflict arbitration, so DO NOTHING cannot swallow it |
| Upsert on an existing id: `DO UPDATE SET created_at = '2099…'` or `= excluded.created_at` | `42501`. The DO UPDATE arm fails on the missing UPDATE policy (USING); the `excluded` arm fails on (f) |
| Plain `UPDATE … SET created_at` | 0 rows (default-deny, unchanged) |
| `MERGE … WHEN NOT MATCHED THEN INSERT` future / default | `42501` / OK |
| `COPY … FROM` | `42501` (no privilege, and COPY FROM is unsupported under RLS) |
| Shadowing `now()` through `search_path` | Not possible. Staff cannot create objects in `public`, and the policy expression is OID-bound to `pg_catalog.now()` |
| `anon` (any `created_at`) | `42501` on the permissive arm, unchanged |
| service_role omitted (manage-store-user shape) / explicit past | OK / OK. BYPASSRLS, as designed |

Real PostgREST requests, staff and admin:

| Request | Result |
|---|---|
| Future, `null`, or `"infinity"` body with `return=representation` or `return=minimal` | 403 / `42501` (f) |
| `resolution=merge-duplicates` and `resolution=ignore-duplicates` upserts with a future value | 403 / `42501` (f) |
| Bulk insert with `missing=default`, one row future | 403 |
| `?columns=` that leaves out `created_at` while the body carries 2099 | 201. PostgREST drops the key and the row gets the server clock (verified) |
| The `addAuditEvent` shape (2 rows, `created_at` omitted, `return=representation`) | Passed RLS (406 PGRST116 = the insert ran, then the transaction rolled back) |

**Does `now()` in a PostgREST request equal the column default?** Yes. PostgREST runs each request in one transaction. `now()` is `transaction_timestamp()`, which is stable inside that transaction. The default and the WITH CHECK are evaluated in the same transaction, so they are bit-identical `timestamptz`.

The INVOKER PO RPCs (`receive_purchase_order`, `close_short_purchase_order`, `cancel_purchase_order`) insert `(store_id, user_id, action, detail, item_ref, value)` only, per their live bodies, so their rows take the default and pass. W-6 and `staff_receiving_gate` 45/45 confirm this.

The DEFINER writers keep bypassing RLS as owner, because FORCE RLS is off. I checked `record_missed_orders_for_day`: it does not set `created_at` on its INSERT. `addAuditEvent` (`src/lib/db.ts:2836-2846`) and the manage-store-user service write omit `created_at`. No legitimate writer regresses.

D-10's in-txn `probe_wide_select using (true)` policy is created and dropped inside the test transaction, which is then rolled back. Other sessions, including `permissive_policy_lint`, never see it. This is not a security concern.

### New finding

- **L6 (Low): policy (f) is not retroactive. Any future-dated or NULL-dated rows already on prod stay pinned and are not API-deletable once the spec 170 DELETE age gate lands.**
  - **Where:** migration `:167-178`, together with the `admin_delete_audit_log` age gate (`:146`).
  - **Local state:** 0 such rows (`count(*) filter (where created_at is null or created_at > now())` = 0 / 0).
  - **Prod:** not checked (out of scope).
  - **Fix:** add a read-only pre-check to the spec's §12 prod sequence: `select count(*) filter (where created_at is null), count(*) filter (where created_at > now()) from public.audit_log;`. If either count is non-zero, the operator decides on those rows before the apply.
  - **Why Low:** the probability is low, because the attack had no benefit before this spec made rows undeletable. Recovery exists through MCP/psql.

### Status of prior findings

| Finding | Status |
|---|---|
| M1 | **Closed** (policy (f), C-1..C-8, all probes above) |
| L1 | Open. Deferred by the owner as F-170-6. No change |
| L2 | Open. Accepted by owner decision 3. No change |
| L3 | **Closed (documented).** The spec Risks now state that immutability is per row, not per store or actor |
| L4 | Open. Deferred by the owner as F-170-5. No change |
| L5 | Informational. No change |
| L6 | New, Low (above) |

### Updated counts

- **Critical:** 0
- **High:** 0
- **Medium:** 0 (M1 closed)
- **Low:** 4 (L1, L2, L4, L6)
- **Informational:** 1 (L5)

Nothing blocks.

### Dependencies (delta)

No `package.json` change in the fix pass, so `npm audit` was skipped.
