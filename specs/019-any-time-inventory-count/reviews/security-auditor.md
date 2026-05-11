# Security audit for Spec 019 — Any-time inventory count (Round 2)

Scope round 2: re-verify all 4 round-1 Criticals and the 1 High against the
patched DB. Tested live against the local stack with both migrations applied:

```
20260513000000_inventory_counts.sql           (initial; edited in round 2)
20260513120000_inventory_counts_consistency.sql (new; closes the Criticals)
```

PoCs run under `manager@local.test` (`22222222-2222-2222-2222-222222222222`,
JWT `app_metadata.role = 'user'`, member of Towson + Frederick only, NOT
Charles) via `set local role authenticated` + `set_config('request.jwt.claims',
…, true)` against `docker exec supabase_db_imr-inventory psql -U postgres -d
postgres`. `package.json` is unchanged — `npm audit` skipped.

---

## Round-1 finding verdicts

### C1 — `submitted_by` audit-trail forgery → **PASS (closed)**

The `inventory_counts_set_submitted_by` BEFORE INSERT/UPDATE trigger
(`20260513120000_inventory_counts_consistency.sql:54-70`) overrides
`new.submitted_by := auth.uid()` unconditionally. Verified live.

PoC: as the manager (`2222…`), INSERT a row with `submitted_by =
'1111…'` (admin's UID). The persisted row shows `submitted_by =
22222222-2222-2222-2222-222222222222` (the manager's UID, not the
forged value):

```
                  id                  |             submitted_by
--------------------------------------+--------------------------------------
 d7ef9b52-81b4-462d-be7a-7731fa501cdb | 22222222-2222-2222-2222-222222222222
```

Trigger function is `security invoker`, `set search_path = public`,
language plpgsql — matches the REPORTS-1 `ran_by` precedent.

### C2 — Cross-store `item_id` spoof → **PASS (closed)**

The `inventory_count_entries_check_store` BEFORE INSERT/UPDATE trigger
(`20260513120000_inventory_counts_consistency.sql:79-113`) reads the
parent count's `store_id` and the entry's `item_id.store_id` under the
caller's RLS and raises `42501` on mismatch. Verified live.

PoC: as the manager, create a legitimate count in Towson, then attach an
entry pointing at a Charles item (`033ffd80-…`). Trigger fires:

```
ERROR:  inventory_count_entries: item store mismatch with parent count
CONTEXT:  PL/pgSQL function inventory_count_entries_check_store() line 18 at RAISE
```

Error message is generic — no UUIDs or store names leaked. Function is
`security invoker`, `set search_path = public`.

### C3 — UPDATE policy lets store members rewrite audit fields → **PASS (closed)**

`20260513120000_inventory_counts_consistency.sql:119-122` drops both
UPDATE policies (`store_member_update_inventory_counts` and
`store_member_update_inventory_count_entries`). With no UPDATE policy,
RLS denies the operation entirely under any non-superuser caller.

PoC: as the manager, attempt to rewrite `submitted_by`, then `kind`, on
a count that the manager themselves submitted. Both UPDATEs match 0 rows:

```
UPDATE 0      -- attempted submitted_by rewrite
UPDATE 0      -- attempted kind rewrite
```

Entry UPDATE likewise blocked:

```
UPDATE 0      -- attempted actual_remaining rewrite by the original submitter
```

`pg_policies` confirms no UPDATE policy on either table:

```
 schemaname |        tablename        |                 policyname                  |  cmd
------------+-------------------------+---------------------------------------------+--------
 public     | inventory_count_entries | store_member_insert_inventory_count_entries | INSERT
 public     | inventory_count_entries | store_member_read_inventory_count_entries   | SELECT
 public     | inventory_counts        | store_member_insert_inventory_counts        | INSERT
 public     | inventory_counts        | store_member_read_inventory_counts          | SELECT
```

(Only SELECT and INSERT remain on both tables. Append-only posture
achieved.)

### C4 — DELETE policy lets store members destroy audit history → **PASS (closed)**

Same migration (`L128-131`) drops both DELETE policies.

PoC: as the manager, attempt to DELETE an admin-authored count in Towson
(a store the manager IS a member of). DELETE matches 0 rows:

```
DELETE 0
```

The store-cascade-delete path
(`stores(id) on delete cascade`, migration L72) still works because that
runs as the postgres role — verified by inspecting the consistency
migration's own commentary at L41-46.

### H1 — `client_uuid` cross-store collision → **PASS (closed)**

The partial-unique index is now scoped to `(store_id, client_uuid)`
(`20260513000000_inventory_counts.sql:102-104`) and the RPC's dedup
check joins on `store_id` (L284-296). Verified live.

PoC: two different users in two different stores submit with the same
`client_uuid` (`deadbeef-0000-0000-0000-000000000001`). Both calls
succeed with `conflict: false` and produce distinct rows:

```
                  id                  |               store_id               |             submitted_by
--------------------------------------+--------------------------------------+--------------------------------------
 4a69353a-dde6-…-235266bcba00         | 00000000-0000-0000-0000-000000000001 | 22222222-…-222 (Towson manager)
 6fd41d2e-2812-…-1dcdb539ea18         | 1ea549bb-…-9311d9fdec                | 33333333-…-333 (Charles master)
```

No 23505 raised. Same-store + same-UUID still returns
`conflict: true` with the existing `count_id` and zero new entries:

```
 first call:  {"conflict": false, "count_id": "ef61bf6e-…", "entry_ids": [...]}
 second call: {"conflict": true,  "count_id": "ef61bf6e-…", "entry_ids": []}
```

Idempotency contract holds.

---

## Round-2 side checks (new attack surface introduced this round)

### (6) Append-only correctness — RPC does not internally UPDATE

`submit_inventory_count` body (`20260513000000_inventory_counts.sql:231-381`)
issues only `INSERT INTO inventory_counts` (L300-310) and `INSERT INTO
inventory_count_entries` (L355-362) inside the implicit transaction. The
idempotency-hit path at L284-296 issues a `SELECT … RETURN` early —
never UPDATEs. Confirmed by `grep -n "update " 20260513000000_*.sql` →
nothing.

**Result:** dropping the UPDATE policies does not break any RPC
operation. No internal UPDATE path exists.

### (7) Trigger functions don't leak data

`pg_proc` inspection confirms both new trigger functions are
`security invoker`, `proconfig = {search_path=public}`:

```
       proname                       | is_definer |        config
-------------------------------------+------------+----------------------
 inventory_count_entries_check_store | f          | {search_path=public}
 inventory_counts_set_submitted_by   | f          | {search_path=public}
```

Error messages are generic strings — no row UUIDs, no store names, no
foreign-row data:

- `inventory_count_entries: parent count not found or not visible`
- `inventory_count_entries: item store mismatch with parent count`

No `RAISE NOTICE` calls anywhere. The trigger function body is read-only
on `inventory_counts` and `inventory_items` under the caller's RLS, so a
caller never sees what they couldn't already see via PostgREST.

### (8) `coalesce(notes, '')` removal — NULL pass-through verified

The RPC was edited to pass `v_entry.notes` directly (no `coalesce`).
PoC: submit two entries, one with `notes: null` and one with
`notes: "actually-text"`:

```
   actual_remaining |     notes     | is_null
   -----------------+---------------+---------
              1.000 |               | t
              2.000 | actually-text | f
```

NULL stays NULL; "actually-text" persists exactly. No empty-string
coercion. Downstream `where notes is not null` filters will behave
consistently with the parent `inventory_counts.notes` shape.

### (9) Frontend `client_uuid` once-per-submit + button gating

`InventoryCountSection.tsx:308-322` mints `clientUuid` once per
`onSubmit()` invocation (lines 308-311) BEFORE `setSubmitting(true)`
(L312). Submit button has:

```
disabled={submitting || nonBlankCount === 0 || hasNegative}
pointerEvents: 'none' on web while submitting
```

— at lines 387-396. A genuine double-click separated by a React render
cycle (~16ms) is blocked by the disabled state. A sub-render-cycle
double-fire would mint TWO different `clientUuid`s and INSERT two rows
— the same shape as REPORTS-1, where it was accepted as a UX trade-off
that the idempotency key is per-invocation. Tested at the DB level: the
PoC #9 same-store-same-UUID second call returns `conflict: true` and
inserts zero new rows, so any code path that DOES reuse the UUID
(network-retry on the same `onSubmit` invocation) is idempotent.

The remaining double-click-during-render gap is a Low UX hardening note
— would be closed by minting `clientUuid` once at component-mount or
moving the disable into a ref-guard. Not a security finding.

---

## NEW issues introduced this round

None Critical, none High. The two new triggers and the four dropped
policies tighten security; no regression observed.

---

## Carried-over Mediums and Lows (deferred per release proposal §P3)

Round-1 M1 (notes length cap), M2 (unit allowlist), M3 (entries-array
size cap), and M4 (console.warn echoes full error object at
`src/lib/db.ts:674`) all remain. Release proposal explicitly defers
them; not re-litigated here. M4 unchanged: `db.ts:674` still
`console.warn('[Supabase] submitInventoryCount:', error.message, error)`
while sibling helpers log only `.message` (L706, L748).

Round-1 L1-L4 likewise remain (`clientUuid` returned in detail
payload; entries not on realtime; migration date `2026-05-13` is 2 days
beyond today's `2026-05-11` — confirmed both migrations apply cleanly
and load in order; cosmetic name regex).

---

## Dependencies

No `package.json` changes — `npm audit` skipped.

---

## Verdict

| Round-1 finding | Round-2 verdict |
|---|---|
| C1 — submitted_by forgery | **PASS (closed by trigger)** |
| C2 — cross-store item_id spoof | **PASS (closed by trigger)** |
| C3 — UPDATE rewrite | **PASS (closed by dropped policies)** |
| C4 — DELETE destruction | **PASS (closed by dropped policies)** |
| H1 — client_uuid cross-store collision | **PASS (closed by store-scoped partial unique + RPC dedup filter)** |

**No NEW Critical or High introduced this round.** All four round-1
Criticals are closed by the consistency migration; the round-1 High is
closed by the edit to the initial migration's partial-unique index and
RPC dedup filter.

**Block recommendation: NO.** Spec 019 is unblocked from a security
perspective. The deferred Mediums (M1-M4) and Lows (L1-L4) remain
non-blocking and can ship as follow-ups.

Side note for CLAUDE.md (mentioned in round 1): this is now the third
spec on this codebase (REPORTS-1 round-1, REPORTS-1 round-2, Spec 019)
where the `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes
pattern produced Criticals. Worth documenting as a known pitfall in the
"RLS — every new table needs policies" section: for any
audit-trail-bearing table, ALSO require a BEFORE INSERT/UPDATE trigger
overriding the audit columns and asserting cross-table consistency.
That belongs in a separate documentation spec, not Spec 019.
