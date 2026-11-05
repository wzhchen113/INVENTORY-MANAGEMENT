## Security audit for spec 179

Auditor: security-auditor, 2026-10-26. This was a read-only review of the working tree.

**DB activity:** all probes ran against the LOCAL stack (`supabase_db_imr-inventory`), each inside `begin … rollback`. No commit, no `db reset`, no prod access. A post-probe check confirmed:
- no leftover functions or rows;
- all 5 `inventory_items` triggers are still `O`;
- 0 tombstones.

**Files reviewed:**
- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql` (new)
- `supabase/tests/inventory_items_identity_lock.test.sql` (new)
- the spec, including the `## Backend design` §10 runbook

**Context read:**
- spec 177's security review (L1 is the origin of this spec)
- `supabase/functions/pwa-catalog/index.ts` (it exposes `inventory_items.id` to the customer PWA)
- the live `stores` / `inventory_items` policies and FKs in `pg_policy` / `pg_constraint`

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- **M1. Deleting and re-inserting the same id in ONE statement (a writable CTE) gets past R-2 for every caller. Vector 3 is closed only across statements.**
  - **Where:**
    - `supabase/migrations/20261026100000_inventory_items_identity_lock.sql:177-180`: the writer is AFTER DELETE;
    - `:218-221`: the check is BEFORE INSERT;
    - `:9-10` and spec R-2 claim the guard applies "for EVERY caller".
  - **Why it happens:** the deleting and inserting statements are one query, so the writer's AFTER DELETE row event is queued until the end of that query. The INSERT's BEFORE trigger runs before that and sees no tombstone. The `FOR KEY SHARE` probe also finds nothing, because the row was already deleted by the current command.
  - **Verified locally, as `postgres` and as `authenticated` master (rolled back):**
    ```sql
    with d as (delete from public.inventory_items where id = X returning id, catalog_id)
    insert into public.inventory_items (id, store_id, catalog_id) select id, <store A>, catalog_id from d;
    ```
    The item, originally in store B, now lives in store A. The tombstone `(X, B)` is written afterwards, after the move has already happened. As a control, the same delete and insert run as two statements in one transaction is refused (42501, R-2).
  - **Reachability:** none from an untrusted surface.
    - PostgREST can't build a delete+insert CTE.
    - No RPC or edge function deletes `inventory_items` (grep of `supabase/migrations`, `supabase/functions` and `src/lib` finds no `delete from inventory_items`).
    - The only way in is raw SQL as `postgres` or `service_role`, or a future definer RPC written this way.

    That is why this is not High. But R-2, the migration header and AC-12 all promise a guard that holds for every caller, and it doesn't.
  - **Fix (recommended, verified locally in a rolled-back transaction):** turn `inventory_items_check_tombstone` into an **AFTER INSERT … FOR EACH ROW** trigger.
    - Keep the same SECURITY DEFINER, `search_path ''` and static 42501 message, and `return null`.
    - Drop the `for key share` probe.

    Why this works:
    - AFTER row events fire in queue order, so the CTE's DELETE event writes the tombstone before the INSERT event checks for it. Probed: the CTE is refused with the R-2 message.
    - Concurrency still fails closed. The INSERT's unique-index check already waits for an in-flight deleter. If the deleter commits, the AFTER check takes a fresh READ COMMITTED snapshot and sees the tombstone. If it rolls back, the insert fails with 23505.
    - The check now runs after RLS WITH CHECK, which also closes L1 below. Probed: a zero-store caller gets the RLS message, a two-store master is refused cross-store with the R-2 message, and a same-store reinsert is accepted.
  - **What else has to change:** T69-T72 / AC-18 (event list), the §10 md5s, and the design notes in §2.4.

    If the owner prefers to keep the current shape, record the single-statement residual in the migration header and in spec §11 instead. Then both texts stop claiming every-caller coverage.

### Low
- **L1. For a caller who can't see the named store, the BEFORE INSERT check runs before RLS WITH CHECK and acts as an oracle for deleted ids.**
  - **Where:** `20261026100000_inventory_items_identity_lock.sql:187-206` / `:218-221`; design D-5 (spec L313).
  - **Why D-5's argument doesn't hold:** D-5 says the R-2 message is "strictly less than" the existing 23505 PK oracle. That is true only for a caller who can insert into the store they name. Postgres runs BEFORE row triggers, then RLS WITH CHECK, then the unique check. So an `authenticated` user with **no** store access never reaches 23505: they always get the RLS message. The new trigger gives them a second, different answer. In this project that includes every customer-PWA user, because it shares this Supabase project.
  - **Verified locally (rolled back), as a random `sub` with no stores:**
    - inserting a tombstoned id while naming a store **other than** its original store returns `inventory_items: id was previously used by another store`;
    - naming the **original** store returns `new row violates row-level security policy …`;
    - a live other-store id and a fresh id both return the RLS message.
  - **What leaks:** whether a known item id was deleted. By cycling `store_id` values, the caller can also learn which store it was deleted from. `pwa-catalog` (`supabase/functions/pwa-catalog/index.ts:202`) gives customer-PWA clients `inventory_items.id` values, so the ids aren't secret to them. The value of the leak is negligible, since the same customer can see an item vanish by re-fetching the catalog. No row data, store name or other column is exposed.
  - **Fix:** M1's AFTER INSERT form closes this as a side effect. If M1 is not taken, correct D-5's reasoning in the spec ("strictly less" is false for zero-store callers) and accept the leak as Low.

- **L2. `anon` and `authenticated` keep TRIGGER (and REFERENCES / MAINTAIN) on `public.inventory_item_tombstones`. A raw session could attach a trigger that the SECURITY DEFINER writer would then fire as `postgres`. This is not reachable today, and it is a project-wide issue.**
  - **Where:** `20261026100000_inventory_items_identity_lock.sql:122`. The Option A revoke removes TRUNCATE only. The ACL is `anon=arwdxtm, authenticated=arwdxtm`.
  - **Verified locally (rolled back):** as `authenticated`, both of these succeed:
    - `create function pg_temp.f() returns trigger …`
    - `create trigger … after insert on public.inventory_item_tombstones … execute function pg_temp.f()`

    Any later tombstone write by `inventory_items_record_tombstone()` (definer = `postgres`) would run that function as `postgres`.
  - **Reachability:** none.
    - `authenticated` / `anon` are NOLOGIN.
    - The only route in is PostgREST's `authenticator` `SET ROLE`, and PostgREST cannot issue DDL.
    - The same default-ACL TRIGGER grant exists on every `public` table, including `inventory_items` itself, which several definer RPCs write. This spec neither creates nor widens the class.
  - **Fix:** no change required in this spec. Fold TRIGGER (and REFERENCES) into the existing spec 170 L4 default-ACL / 47-table TRUNCATE sweep.

    Optional defense in depth for this table only: widen line 122 to `revoke truncate, trigger, references on public.inventory_item_tombstones from anon, authenticated;`. This is lint-neutral, because `public_grants_explicit` arm (1) asserts SELECT only. It would also need two more privilege arms in pgTAP.

- **L3 (runbook nit). §10 Step 4's `select count(*) from public.inventory_item_tombstones; -- expect 0`, and the identical post-probe check in Step 5 (spec L706, L771), can false-alarm.**
  - **Why:** any genuine prod item delete or store delete between Step 2 and the check writes a real tombstone.
  - **Impact:** it fails toward STOP/report, so it is not a safety issue.
  - **Fix:** in Step 5, assert there is no tombstone for a probe item instead. The probes' random id is not recoverable, so check `count(*) where deleted_at >= <Step 2 time> and store_id in (<the probe's two stores>)` against the real deletes, or compare against the Step 4 count. Alternatively, note that a non-zero count needs a look at `deleted_at`, not an automatic STOP.

### Verification notes (checked, no finding)

**Vector 1: PATCH `store_id`.** Closed for every caller.
- R-1 is `BEFORE UPDATE OF id, store_id` with a value comparison (`:70-100`).
- Probed as master (refused, 42501):
  - `INSERT … ON CONFLICT (id) DO UPDATE SET store_id = excluded.store_id`;
  - `… DO UPDATE SET id = gen_random_uuid()`.
- PostgREST `merge-duplicates` upserts compile to that same conflict arm.
- No rules on `inventory_items` (`pg_rewrite` = 0).
- No later BEFORE UPDATE trigger writes either column. The lock sorts first, and the other two triggers only stamp timestamps.
- Column-scoped firing can't be dodged: the only way to change the column without naming it is a later BEFORE trigger, and none exists. Creating one needs table ownership or the raw-session TRIGGER privilege (see L2).

**Vector 2: PATCH `id`.** Closed by the same trigger: pgTAP T07/T16 plus my upsert-`SET id` probe.

**Vector 3: delete, then reinsert.**
- Closed across statements, for every caller. Probed: two statements in one transaction are refused.
- Open within a single statement (M1).
- **Concurrency (design D-7), reasoned and correct:**
  - The `FOR KEY SHARE` probe blocks on an in-flight deleter's row lock.
  - If the deleter commits, READ COMMITTED skips the vanished row. The next plpgsql statement (volatile, so it takes a fresh snapshot) sees the committed tombstone and refuses.
  - If the deleter rolls back, the row survives and the insert fails with 23505.
  - Under RR/SERIALIZABLE the result is 40001.
  - A check that runs before the deleter starts holds KEY SHARE, and the insert then fails with 23505 against the live row.
  - I did not run a two-session demo: proving the commit branch needs a committed delete in the shared DB, which is out of bounds.
- **Storeless items (D-4):** no tombstone is written. That is sound, because spec 177's checks require a non-null store match.
- **Store-id reuse:** not a vector.
  - `stores` INSERT/UPDATE/DELETE are `auth_is_privileged()`-only.
  - `order_approvals_store_id_fkey` and `purchase_orders_store_id_fkey` CASCADE, so a deleted store's lines die with it.

**SECURITY DEFINER hygiene.**
- **Privilege flags and owner:**
  - the writer and the check are `prosecdef = t`, `proconfig = {search_path=""}`, owner `postgres`;
  - the lock is `prosecdef = f`, `{search_path=public}`.
- **Qualification:** every relation is qualified as `public.*`. The `now()` default is stored as an OID, so it needs no lookup.
- **Shadowing:**
  - `authenticated` has no CREATE on `public`;
  - `pg_temp` is never searched for functions or operators;
  - the invoker lock reads no relation.
- **EXECUTE:** `proacl = {postgres=X, service_role=X}` on all three, so there is no PUBLIC, anon or authenticated EXECUTE. Trigger functions can't be called outside a trigger anyway.
- **Owner bypass:** the tombstone table is `relowner postgres`, `relrowsecurity t`, `relforcerowsecurity f`. Owner bypass works, and T71 pins owner equality.
- No dynamic SQL and no caller-controlled identifiers.

**Tombstone table lockdown (D-1 Option A)**, probed as `authenticated` master after seeding one row as postgres:
- SELECT sees 0 rows;
- INSERT raises `new row violates row-level security policy for table "inventory_item_tombstones"`;
- UPDATE affects 0 rows, and DELETE affects 0 rows;
- TRUNCATE is refused with `permission denied for table inventory_item_tombstones`;
- the seeded row is intact afterwards.

`anon` has the same ACL, no BYPASSRLS, and is not a superuser, so the pgTAP catalog arms are adequate. I did not `set role anon`, to avoid the spec 067 segfault. The table has 0 policies and is not in `supabase_realtime`.

**Tombstone forgery.**
- `anon` and `authenticated` cannot insert a tombstone.
- The only way they can create one is to really create and then delete an item in a store they can see. That ties the tombstone to that store.
- They can't pre-squat a future id, because ids come from `gen_random_uuid()` and the PK on `inventory_items.id` is global.
- `service_role` and `postgres` can write or delete tombstones. They are trusted identities, as design §11.7 notes.

**Error messages.**
- Both messages are static, contain no row data, and return 42501 (HTTP 403).
- PostgREST does not return the plpgsql CONTEXT line.
- The only information leak is the L1 oracle.

**pgTAP file.**
- One top-level `begin;` (L36) and `rollback;` (L918). The other `begin` lines (L47, L224, L352) are DO-block bodies.
- No `commit`, no `\c`, no trigger disable left in the committed file.
- No `set role anon`.

**§10 prod runbook safety.**
- The Step 1 pre-check is read-only.
- Step 2 is the verbatim file in one `execute_sql` call, and the migration body is all-or-nothing.
- Steps 3 and 4 write only the `schema_migrations` row.
- **All three Step 5 DO blocks end in an exception on every path:**
  - SKIPPED, OK and FAILED all `raise exception`;
  - the inner handler catches only 42501 and re-raises;
  - any other error propagates.

  So the synthetic catalog row, the item and probe 3's tombstone always roll back.
- **Side effects:**
  - `catalog_ingredients` has only a BEFORE UPDATE stamp trigger;
  - `inventory_items` has no AFTER INSERT/UPDATE trigger;
  - realtime decodes only committed transactions.
- Step 7 exports the tombstones before a full drop. Their contents are ids and store ids only, no PII.

### Dependencies
No `package.json` changes, so `npm audit` was skipped.

---

## Fix round 1 re-review

Auditor: security-auditor, 2026-10-26.

**Re-read:**
- the updated migration: the check is now AFTER INSERT with the narrowed `FOR KEY SHARE` probe (L208-263);
- the updated pgTAP file (`plan(80)`, T74-T80);
- the "Fix round 1" entry under `## Files changed`;
- the re-ruled D-7;
- §10 Steps 4-5, including the new probe 4.

**Local state:** the check trigger is `AFTER INSERT … FOR EACH ROW`, and no BEFORE INSERT trigger remains. The local normalized md5 of `inventory_items_check_tombstone()` is `9cfb8c5a2e02129e7ec9c1917c33d4d3`, which matches the recorded value. `prosecdef = t`, `search_path=""`, and `proacl = {postgres=X, service_role=X}`, so none of that changed.

**Probe hygiene:** every probe below ran in one `begin … rollback` on the local stack, with no commit and no `db reset`. A check afterwards found 0 tombstones, 0 probe items and 0 probe catalog rows.

### Status of original findings

| Finding | Status | Evidence |
|---|---|---|
| **M1** single-statement CTE delete + reinsert | **RESOLVED** | The probe ran `with d as (delete … returning id, catalog_id) insert … select id, <A>, catalog_id from d`. **As postgres:** refused, `42501 inventory_items: id was previously used by another store`. The item is still in store B and has 0 tombstones (both rolled back). **As an `authenticated` master:** the same refusal, and the item is still in B. T74-T77 and §10 probe 4 pin it. |
| **L1** deleted-id oracle for zero-store callers | **RESOLVED** | A zero-store `sub` got `42501 new row violates row-level security policy for table "inventory_items"` in all four cases: a tombstoned id naming store A, the same id naming its original store B, a live other-store id, and a fresh id. The answers are identical, so there is no oracle. T80 pins it. |
| **L2** TRIGGER / REFERENCES / MAINTAIN kept on the tombstone table | **OPEN, accepted as is** | Unchanged and still unreachable (NOLOGIN roles; PostgREST can't issue DDL). It belongs to the project-wide default-ACL class (spec 170 L4 sweep). It doesn't block. |
| **L3** runbook "expect 0" tombstone count | **RESOLVED** | Step 5 now compares against N4, the count recorded in Step 4, and Step 4 says to inspect any non-zero rows by `deleted_at` instead of stopping automatically. Any residual drift fails toward reporting, never toward persisting a write. |

### Requested checks

**Upsert of a live id** (as master, live item in store B). All four results match the contract:

| Case | Statement | Result |
|---|---|---|
| R4a | `on conflict (id) do update set store_id = excluded.store_id, par_level = …`, same store | accepted, `par_level` changed. The conflict arm fires no INSERT event, so the check does not run |
| R4b | the same statement naming store A | `42501 inventory_items: id and store_id are immutable` (R-1) |
| R4c | `on conflict (id) do nothing`, naming A | a silent no-op; the row is still in B |
| R4d | an upsert of a **tombstoned** id under another store | takes the insert path, so the AFTER check refuses it with the R-2 message |

**The narrowed probe takes no extra lock on a normal insert.** I checked this through `xmax` on the inserted row. A `FOR KEY SHARE` lock would stamp the locker's xid there.
- After a fresh insert, `xmax = 0`.
- After a same-store delete + reinsert, `xmax = 0`.
- Control: an explicit `select … for key share` on the same new row sets `xmax` to the transaction's own xid. So the method can tell the two cases apart, and the `store_id is distinct from new.store_id` predicate keeps the probe off the new row.
- Under READ COMMITTED the probe can never match a row: after a successful insert, the only visible row with that id is the new one.

**§10 probe 4 always raises.** Every path ends in `raise exception`:
- SKIPPED when there are no two stores in one brand;
- OK or FAILED from inside the 42501 handler;
- FAILED when the CTE is accepted;
- any other SQLSTATE propagates.

The synthetic catalog row, the item and any tombstone therefore always roll back. Probes 1-3 are unchanged and still always raise. Neither table has an AFTER INSERT side-effect trigger, and realtime decodes only committed transactions.

### D-7 ruling: confirmed, with one gap (see L4)

I did no two-session demo. Every variant that produces 40001 needs a concurrent transaction to **commit** a delete, which would write a lasting tombstone into the shared local DB. The following is reasoned from the executor's behavior.

**READ COMMITTED (PostgREST's default and every app path): fails closed. Confirmed.**
- Either tx1's delete of X(B) is in flight, and tx2's unique-index check waits for it, or tx1 has already committed.
- If tx1 rolls back, tx2 fails with 23505.
- If tx1 commits, the AFTER check runs after the wait. It is volatile plpgsql, so each statement takes a fresh snapshot, sees the committed tombstone, and returns R-2.
- tx1 can't commit between tx2's unique check and the AFTER trigger. A live X(B) at unique-check time means 23505, and a delete in progress means a wait.

**REPEATABLE READ / SERIALIZABLE, when X(B) was created BEFORE tx2's snapshot: fails closed. Confirmed.**
- X(B) is visible in tx2's snapshot.
- The unique check passes, because it uses a dirty snapshot and the tuple is dead.
- The probe selects X(B), since B ≠ A, and `FOR KEY SHARE` reaches `heap_lock_tuple`, which returns TM_Deleted. Under a transaction snapshot, `ExecLockRows` raises SQLSTATE 40001.
- The SQLSTATE is the contract. The exact message text ("concurrent delete" vs "concurrent update") depends on the Postgres version, so §4's message column shouldn't be relied on.
- The dead index entry can't be pruned or killed while tx2's snapshot holds back the horizon.
- **No app path can reach RR:** no `public` function sets `default_transaction_isolation` in `proconfig` (checked), so no PostgREST RPC runs at RR.

**REPEATABLE READ / SERIALIZABLE, when X(B) was created AFTER tx2's snapshot: does NOT fail closed. This is new finding L4 below.**

### New findings

#### Critical / High / Medium
- None.

#### Low
- **L4. Under REPEATABLE READ / SERIALIZABLE, the R-2 check can be bypassed when the other-store row was both created and deleted after the inserting transaction's snapshot.**
  - **Where:** `20261026100000_inventory_items_identity_lock.sql:225-237`, design D-7 (spec L337), §11 risk 6, and the comment at migration L244-245 ("fails a REPEATABLE READ / SERIALIZABLE race closed").
  - **Sequence:**
    1. tx2 starts REPEATABLE READ and takes its snapshot.
    2. X is created in store B and committed. A store-B approval names X.
    3. X(B) is deleted and committed, which writes the tombstone `(X, B)`.
    4. tx2 inserts X under store A.
  - **Why the check misses it:**
    - The unique check passes, because the X(B) tuple is dead.
    - The probe can't see X(B), because it was inserted after tx2's snapshot, so there is nothing to lock and no 40001.
    - The tombstone is also invisible to the snapshot.
    - The check passes, and tx2 commits X in store A, which re-homes the approval line.
    - SSI does not save SERIALIZABLE: tx0 and tx1 are app transactions running at READ COMMITTED, so they take no SIREAD locks and there is no dangerous structure to detect.
  - **Reachability:** none from an untrusted surface.
    - PostgREST runs READ COMMITTED, and no RPC is configured for RR.
    - The attacker needs a raw `postgres` / `service_role` session holding a REPEATABLE READ transaction open across the whole lifetime of X(B), and must learn X's uuid from another channel during that transaction.

    This is narrower than the original M1, which needed only one statement.
  - **What to do:** pick one.
    - **(a) Accept it and fix the wording (minimum):** in D-7, §11 risk 6 and the migration comment at L244-245, say that under RR/SERIALIZABLE the check fails closed only when the deleted other-store row was visible to the transaction snapshot, and that a row created and deleted entirely after the snapshot isn't caught.
    - **(b) Close it:** add an id-to-store **claim** written on insert. Use a table keyed on `id` alone, and have the AFTER INSERT check do `insert … on conflict (id) do nothing`, then compare stores. Under RR, ON CONFLICT against a committed row the snapshot can't see raises 40001, which closes the gap at every isolation level. This is a schema change with a backfill question, so it is the architect's and owner's call. It doesn't block this spec.
    - **(c) Heavier option:** refuse INSERT on `inventory_items` when `current_setting('transaction_isolation') <> 'read committed'`. This is cheap, but it would break any future legitimate RR writer.

    **Recommendation:** (a) now, with (b) only if RR writers are ever introduced.

### Dependencies
No `package.json` changes, so `npm audit` was skipped.

### Fix round 1 summary
- **Resolved:** M1, L1 and L3.
- **Still open, non-blocking:** L2 (project-wide grant class).
- **New:** L4, Low. The RR gap is outside the D-7 ruling's premise and unreachable from PostgREST.
- **Totals:** 0 Critical, 0 High, 0 Medium, 2 Low open (L2, L4).
