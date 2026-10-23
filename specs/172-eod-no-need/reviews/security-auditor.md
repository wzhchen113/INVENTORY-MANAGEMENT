## Security audit for spec 172 (EOD "NO NEED" mark)

Scope: the staged changes listed under `## Files changed` in `specs/172-eod-no-need.md`. The focus was `supabase/migrations/20261024000000_eod_entries_no_need.sql` (column, CHECK, and the recreated `staff_submit_eod` and `report_reorder_list`), the staff offline queue validator, the staff RPC payload, and the admin direct-PostgREST path in `src/lib/db.ts`.

Method: I diffed both recreated function bodies against their latest owners (`20260630000200_staff_submit_eod_multi_vendor.sql` and `20260726000000_reorder_drop_inbound_term.sql`). Then I ran read-only catalog queries against the local DB, where `schema_migrations` head is `20261024000000`, so the migration is applied locally.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `supabase/migrations/20261024000000_eod_entries_no_need.sql:524-528, 461-467` and `src/lib/eodNoNeed.ts` (numeric guards): this is an accountability note, not an authz gap. Any store member can now mark an item NO NEED. That removes the item from variance, COGS and usage, suppresses the `eod_missing_for_item` flag, and zeroes its reorder suggestion across every linked vendor for that cycle. Before this change, skipping an item left a visible `eod_missing_for_item` signal. So a staff member could use NO NEED to avoid producing a count that would show shrinkage. Members could already enter any number, so this grants no new capability. The mark is also attributed: `staff_submit_eod` writes an `audit_log` row with value `'NO NEED'` and an actor from `auth.uid()` that cannot be spoofed (`:163`, `:286-297`). No change required. If shrinkage visibility matters later, make NO NEED marks prominent in Reconciliation.
- `supabase/migrations/20261024000000_eod_entries_no_need.sql:211-240`: a pre-existing input-validation gap that now has one more variant. `eod_entries` has no `(submission_id, item_id)` unique index. Locally the only indexes are the pkey, `item_id`, and `submission_id`. A crafted `p_entries` that lists the same `ingredient_id` twice (one numeric, one `no_need: true`) persists both rows. The report join at `:541-543` then fans out into two `(item, vendor)` rows with conflicting state. Cross-store impact is impossible because the `eod_entries_check_store_trg` BEFORE trigger rejects an item from another store (42501), so this is limited to self-inflicted report noise within a store the caller can already write to. Duplicate numeric entries already had the same fan-out before spec 172. Suggestion for a future spec, not a blocker: dedupe on `ingredient_id` in the RPC, or add a unique index after a backfill check.

### Verified (no finding)

**`staff_submit_eod`: posture and ACL preserved**
- Diffed against the prior owner: the only changes are hunks S1-S5. The `22023` vendor guard, the `auth_can_see_store(p_store_id)` gate (`:144-147`, still before any side effect), the idempotency check, and the actor derivation are byte-identical.
- Live catalog: `prosecdef = t`, `proconfig = {search_path=public}`, ACL `{postgres=X, authenticated=X}`. There is no `=X` PUBLIC entry, so anon cannot inherit EXECUTE through PUBLIC.
- `has_function_privilege` results: anon false, service_role false, authenticated true. Exactly one `pg_proc` row, so no overload was introduced.

**`report_reorder_list`: posture and ACL preserved**
- Diffed against the prior owner: the only changes are hunks R1-R4. It stays SECURITY INVOKER (`prosecdef = f`, as before) with `search_path=public`.
- ACL `{postgres=X, authenticated=X, service_role=X}`, unchanged, with anon false. Exactly one `pg_proc` row.
- Because it is SECURITY INVOKER, the new `no_need_items` CTE reads `eod_entries` under RLS (`store_member_read_eod_entries`), in addition to the first-statement `auth_can_see_store` gate.
- The CTE is scoped through `latest_eod_per_vendor` (`store_id = p_store_id`), and the final join is restricted by `ii.store_id = p_store_id`. A NO NEED mark in store A cannot affect store B's report.

**No search_path hijack**
- Every relation reference in both bodies is `public.`-qualified.
- Neither `anon` nor `authenticated` has CREATE on schema `public` (verified locally).

**The CHECK cannot be bypassed, and NO NEED cannot null out stock**
- `eod_entries_no_need_no_quantity_check` is present and `convalidated = t`.
- Hunk S3 adds `and not coalesce(v_entry.no_need, false)` to the on-hand UPDATE. A NO NEED entry therefore cannot write NULL or 0 to `current_stock`/`eod_remaining`.
- `no_need: true` with any number raises 23514 and rolls back the whole call, parent upsert included.
- A non-boolean `no_need` (for example `"yes"`) fails the `jsonb_to_recordset` cast (22P02). A JSON `null` coalesces to false.
- The admin direct path mirrors this: `src/lib/db.ts:1017-1021` forces all numerics to null when `noNeed`, and `:1075-1078` skips `adjustItemStock`. Both are client-side defense in depth; the DB CHECK is authoritative.

**RLS and grants unchanged**
- No policy was added, so `permissive_policy_lint` is unaffected. RLS is enabled on `eod_entries`.
- Policies remain `store_member_read`/`store_member_insert` (both via `auth_can_see_store`) and `admin_update` (`auth_is_privileged()` AND `auth_can_see_store`). There is no DELETE policy.
- The column inherits table-level grants (spec 097). Anon has column INSERT/SELECT/UPDATE on `no_need`, the same as every other column on the table. RLS denies anon because `auth_can_see_store()` returns false for a null uid. Nothing new here.
- An admin UPDATE that flips a numeric row to `no_need = true` without nulling its numerics is rejected by the CHECK.

**Cross-store item ids rejected**
- `eod_entries_check_store()` rejects any `item_id` whose `inventory_items.store_id` differs from the parent submission's store. This holds for both the SECURITY DEFINER RPC insert and the PostgREST insert.
- The trigger fires before the RPC's `inventory_items` UPDATE, so that UPDATE (which has no `ii.store_id` predicate, a pre-existing shape) cannot be reached with a foreign-store item.

**Staff offline queue (`src/screens/staff/lib/eodQueue.ts`, `isValidEodEntry`)**
- It accepts exactly two shapes:
  - numeric: `no_need` absent or false, `actual_remaining` a number, splits number or null;
  - NO NEED: `no_need === true` with all three numerics `=== null`.
- `no_need: true` combined with any number is rejected on hydrate, so a tampered or stale queue item cannot repeatedly fail on the server.
- The `item_id` string check now runs first for both branches.
- The queue sits in device storage and is self-tamperable, but the server re-enforces everything (CHECK, membership gate, store trigger). Not a trust boundary.

**Staff payload (`src/screens/staff/hooks/useEodSubmit.ts`, `entriesForRpc`)**
- Forwards `no_need: true` only for NO NEED entries. Numeric payloads are byte-identical to before spec 172.
- No new fields reach the RPC beyond `jsonb_to_recordset`'s declared columns, and extra keys are ignored.

**Secrets and PII**
- No new `console.*` or `notifyBackendError` payloads carry tokens or PII. The new `useStore.ts` code logs only `e?.message` on `adjustItemStock` failure, which is pre-existing.
- `scripts/smoke-staff-eod.sh` step 8b reads `SUPABASE_ANON_KEY` and `STAFF_TOKEN` from the environment and prints only ids and status codes, not tokens. No secrets are hardcoded.
- No `EXPO_PUBLIC_*` changes.

**Not in scope / not changed**
- No edge function, `config.toml`, or realtime publication changes.
- The client-side `useRole()` is not used as a security boundary anywhere in the diff.

**Migration safety**
- The migration is additive: `ADD COLUMN ... NOT NULL DEFAULT false` is metadata-only on PG 17, plus a CHECK whose validation scan runs under `lock_timeout = 5s`. No destructive DDL.
- The documented rollback (drop the column) would be destructive once NO NEED rows exist, and the header correctly marks it roll-forward-only.
- Neither the `db-migrations-applied` gate nor pgTAP validates prod ACLs. After the prod apply via MCP, re-run the spec §11 grant probe (`has_function_privilege` anon=false, authenticated=true for both functions; service_role=false for `staff_submit_eod`) against prod.

### Dependencies
No `package.json` or lockfile changes, so `npm audit` was skipped.
