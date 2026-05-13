# Security audit for spec 020 — EOD per-vendor submissions (Round 2)

Round 1 (audit dated 2026-05-12) raised **4 Critical** findings (C1–C4) and **1
High** (H1) against the original three-migration triplet. The implementer
added a fourth migration
(`supabase/migrations/20260514120030_eod_submissions_consistency.sql`) that
mirrors spec 019's template, plus updated `supabase/functions/staff-eod-submit`
to forward `vendor_id` to the new 7-arg RPC overload.

All four round-1 Criticals and H1 have been re-verified end-to-end against
the local stack on 2026-05-12 under `manager@local.test` (uid
`22222222-2222-2222-2222-222222222222`, JWT `app_metadata.role='user'`) and
`admin@local.test` (uid `11111111-1111-1111-1111-111111111111`,
`app_metadata.role='admin'`) impersonation.

**Verdict: 4/4 Criticals CLOSED. 1/1 High CLOSED. No new Critical or High
introduced. Two new informational findings, no fix required for ship.**

---

## Round-1 finding status

### C1 — `submitted_by` forgery via direct PostgREST INSERT — **PASS (closed)**

The new BEFORE INSERT/UPDATE trigger
`eod_submissions_set_submitted_by_trg`
(`supabase/migrations/20260514120030_eod_submissions_consistency.sql:90-94`)
unconditionally overrides `new.submitted_by := auth.uid()`. Re-ran the
original PoC:

```
Manager INSERT with submitted_by='11111111…' (admin's UID):
  RETURNING submitted_by = '22222222-2222-2222-2222-222222222222'
                           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                           manager's actual UID, not the forged admin one.
```

Also verified the inverse: manager INSERT with no `submitted_by` column at
all — trigger still fills it with `auth.uid()`. No bypass via column
omission. The service-role path through `staff_submit_eod_v2` still writes
NULL because `auth.uid()` is NULL in the service-role JWT context, which
matches the v2 RPC's existing explicit NULL write at
`20260514120010_staff_submit_eod_v2.sql:101-102`. Both paths converge.

### C2 — Cross-store `item_id` spoof on `eod_entries` INSERT — **PASS (closed)**

The new BEFORE INSERT/UPDATE trigger
`eod_entries_check_store_trg`
(`supabase/migrations/20260514120030_eod_submissions_consistency.sql:134-138`)
reads both the parent submission's `store_id` and the entry's
`inventory_items.store_id`, and `RAISE EXCEPTION ... USING errcode='42501'`
on mismatch (or on either being NULL / RLS-hidden). Re-ran the original
PoC: manager INSERT in Towson parent with `item_id` pointing at a Charles
item correctly aborts with

```
ERROR:  eod_entries: item store mismatch with parent submission
CONTEXT: PL/pgSQL function eod_entries_check_store() line 18 at RAISE
```

The trigger is `security invoker`, so when the manager (with no RLS
visibility into Charles items) tries to look up the Charles item via
plpgsql `SELECT`, the row is invisible and `v_item_store_id` is NULL, which
also hits the `raise exception` branch. Both the store-mismatch and the
RLS-hidden-item attack vectors close on the same branch.

### C3 — UPDATE rewrite by store member — **PASS (closed)**

The `store_member_update_eod_submissions` / `store_member_update_eod_entries`
policies were dropped and replaced with admin-gated versions that
short-circuit on `auth_is_privileged()`
(`supabase/migrations/20260514120030_eod_submissions_consistency.sql:140-181`).

Re-ran the round-1 PoC and the round-2 EDIT-flow PoC:

```
C3a: Manager UPDATE attempt   → 0 rows matched (RLS blocks non-privileged).
C3b: Admin   UPDATE attempt   → 1 row  matched (EDIT flow preserved).
```

`auth_is_privileged()` short-circuits to true for both
`auth_is_admin()` (JWT `app_metadata.role='admin'`) and
`auth_is_super_admin()` (profiles `role='master'/'super-admin'`), so the
Cmd UI's admin-only EDIT flow (Q5) is preserved while store-members lose
the ability to rewrite audit fields. The C1 trigger additionally
neutralizes the `submitted_by` column-rewrite vector even for privileged
callers (see Finding 6 below for the audit-attribution side effect).

### C4 — DELETE by store member — **PASS (closed)**

The `store_member_delete_eod_submissions` / `store_member_delete_eod_entries`
policies were dropped entirely and no replacement policy was created
(`supabase/migrations/20260514120030_eod_submissions_consistency.sql:192-195`).
Without a permissive DELETE policy, RLS denies DELETE under every
non-superuser caller. Re-ran the round-1 PoC under both manager and admin
sessions:

```
C4a: Manager DELETE attempt → 0 rows matched.
C4b: Admin   DELETE attempt → 0 rows matched (append-only by design).
```

The `stores.id ON DELETE CASCADE` still works because the cascade
executes as the `postgres` role, not via PostgREST — same closure as spec
019's `inventory_counts_consistency.sql:42-45`. Verified by inspecting
the policies on both tables; only INSERT, SELECT, and admin-gated UPDATE
remain.

### H1 — Edge function pre-update sibling-app handling — **PASS (closed)**

`supabase/functions/staff-eod-submit/index.ts:79` adds an explicit
`if (!b.vendor_id) return "vendor_id required (spec 020 per-vendor partitioning)"`
check, and line 125 passes `p_vendor_id: body.vendor_id` to the 7-arg
overload of `staff_submit_eod`. Live tested:

```
POST with vendor_id    → 200 {submission_id, entry_ids, stock_updates}
POST without vendor_id → 400 {"error":"vendor_id required (spec 020 …)"}
POST with vendor_id="" → 400 (same — empty string fails truthy check)
POST with vendor_id=null → 400 (same)
```

Sibling-app callers without the spec-020 update fail loudly with a
client-actionable 400 instead of a 500 from inside the RPC.

---

## Round-2 newly verified items (audit prompt §6-§10)

### 6 — Admin EDIT overwrites `submitted_by` to editor's UID — **informational**

The BEFORE INSERT/UPDATE trigger fires on UPDATE too, which means when an
admin EDITs a submission originally authored by another user, the
`eod_submissions.submitted_by` column is rewritten to the admin's UID.
Verified end-to-end:

```
Step 1: Master (uid 333…) submits EOD →
        eod_submissions.submitted_by = 333…

Step 2: Admin (uid 111…) EDITs via PostgREST upsert →
        eod_submissions.submitted_by = 111…  (master's attribution lost)
```

**Assessment.** Acceptable for ship — `audit_log` preserves the original
attribution as a separate row per submit/edit
(`src/store/useStore.ts:1426-1437` writes a new audit row with the
editor's `userId` and `userName` on every submit / EDIT, while
preserving the prior rows). The historical trail is intact in
`audit_log`; what's lost is only the "who first submitted this row"
detail in `eod_submissions.submitted_by`, which after a Q5 EDIT now reads
"last editor". The consistency migration's comment header at lines 44-53
documents this as the intentional posture. The Cmd UI surfaces submitter
identity through the audit log feed, not through `eod_submissions.submitted_by`
directly, so the user-facing audit story is unaffected.

If the project later wants "first submitter" semantics on the row itself,
add a separate `original_submitter_id` immutable column and only have the
trigger write `submitted_by`. Not blocking; flagged for future
visibility.

### 7 — Cross-store consistency trigger on UPDATE — **PASS**

The trigger is `BEFORE INSERT OR UPDATE`, so cross-store re-pointing via
UPDATE is also blocked. Verified both vectors:

```
UPDATE eod_entries SET item_id = '<cross-store item>'
  → ERROR: item store mismatch with parent submission

UPDATE eod_entries SET submission_id = '<cross-store submission>'
  → ERROR: item store mismatch with parent submission
```

Both fail-fast with `42501`. No way to drift an existing entry into a
cross-store relationship after the fact.

### 8 — `fetchRecentEodDates` dedupe security — **PASS**

`src/lib/db.ts:624-635` queries `eod_submissions` via PostgREST with
`.eq('store_id', storeId)`. RLS gates the SELECT via
`auth_can_see_store(store_id)` from
`20260504173035_per_store_rls_hardening.sql:66-68`. The `Set`-based
dedupe runs on the post-RLS result client-side. Verified directly:

```
Manager visibility of Towson eod_submissions: 19 rows
Manager visibility of Charles eod_submissions: 0 rows
```

A malicious caller passing another store's UUID gets `[]` from the
PostgREST round-trip, then `[]` after dedupe and slice. No cross-store
date enumeration possible.

### 9 — Edge function `vendor_id` validation — **PASS with minor polish opportunity**

The edge function's `validate()` rejects falsy `vendor_id` (empty,
null, undefined) with a clean 400. Tested:

```
{"vendor_id": ""}            → 400  vendor_id required …
{"vendor_id": null}          → 400  vendor_id required …
{"vendor_id": "NOT_A_UUID"}  → 500  invalid input syntax for type uuid
{"vendor_id": "<sql-shaped>"} → 500  invalid input syntax for type uuid
```

The SQL-shaped string is consumed as a literal UUID-malformed value and
rejected by PostgreSQL's UUID type coercion. No injection — `admin.rpc()`
passes args as parameterized bindings, not concatenated SQL.

**Polish opportunity (L-class, no fix required).** Non-UUID strings
return 500 (`rpc failed`) instead of 400 (`bad input`). Add a regex check
in `validate()` so a malformed-UUID submission returns 400 with
`vendor_id must be a UUID`. Improves the staff-app's error-handling UX;
not a security issue. Same pattern would apply to `store_id` and
`client_uuid`.

### 10 — Legacy screen stub failure mode — **PASS**

`src/screens/EODCountScreen.tsx:528` passes `vendorId: ''`. supabase-js
serializes this as `vendor_id: ""` in the PostgREST INSERT body.
PostgreSQL's UUID type rejects with `22P02 invalid input syntax for
type uuid: ""`, which PostgREST surfaces as a 400 to the client. Loud
failure as expected. The user-visible toast (`'[Supabase] submitEODCount
upsert parent'`) will surface the error message in the dev console;
production failure mode is a clean error toast, not a silent
corruption.

Acceptable because:
- The legacy `EODCountScreen.tsx` is gated by `EXPO_PUBLIC_NEW_UI=false`
  per CLAUDE.md, and prod runs with `NEW_UI=true`.
- The failure is at the DB layer (NOT NULL + UUID type) — there's no way
  for the spoof to land bad data.

---

## Out of scope / verified safe (carried from round 1, re-checked)

- **`staff_submit_eod_v2` GRANT posture.** Service-role-only. Authenticated
  cannot execute either overload. Verified with manager impersonation
  attempting the RPC directly — `permission denied for function
  staff_submit_eod`.
- **Realtime publication membership.** Adding a column to a table already
  in `supabase_realtime FOR ALL TABLES` is publication-no-op. No
  docker-restart ritual needed.
- **`useRole()` placeholder** — still not used as a security boundary in
  any spec-020 code. The migration's RLS uses `auth_is_privileged()`
  server-side, which reads the JWT directly.
- **CORS headers on the edge function** — `*` is fine because the
  function authenticates via the constant-time-compared
  `STAFF_SERVICE_TOKEN`, not via cookie / origin trust.
- **PII in logs.** `console.error("[staff-eod-submit] rpc error:", error)`
  at index.ts:129 logs the error object. Same shape as the rest of the
  codebase (round-1 L1). No new regression introduced.

---

## Dependencies

No `package.json` changes — `npm audit` skipped.

---

## Summary

**Round 1: 4 Critical, 1 High, 1 Medium, 2 Low.**
**Round 2: 0 Critical, 0 High, 0 Medium, 1 Low (informational polish on
edge-function UUID validation; no fix required).**

All four round-1 Criticals (C1–C4) and the round-1 High (H1) close cleanly.
The new consistency migration
`supabase/migrations/20260514120030_eod_submissions_consistency.sql` mirrors
spec 019's
`supabase/migrations/20260513120000_inventory_counts_consistency.sql`
template precisely and is the right shape for the recurring
`auth_can_see_store(store_id)`-alone-is-insufficient-for-writes lesson.

PoC artifacts cleaned (`delete from public.eod_submissions where date in
('2099-01-01', '2099-02-02', '2099-03-03', '2099-04-04', '2099-05-01',
'2099-05-02', '2099-05-03', '2099-05-04', '2099-05-05', '2099-05-06',
'2099-06-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-08-08',
'2099-09-09', '1999-12-31');`).

**No round-2 Critical introduced. No round-1 Critical remains open.
Spec is unblocked from a security perspective.**
