# Security audit for spec 086

Scope: Cases + Units dual-entry on the staff EOD count screen. The
`staff_submit_eod` SECURITY DEFINER RPC is changed additively to persist two
client-supplied numeric values (`actual_remaining_cases` / `actual_remaining_each`)
inside its existing `p_entries` jsonb; the offline queue key bumps `:v1 → :v2`.

Files reviewed:
- `supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql` (the RPC change)
- `supabase/tests/staff_submit_eod_cases_each.test.sql` (pgTAP)
- `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql` (the baseline being diffed)
- `supabase/migrations/20260514120030_eod_submissions_consistency.sql` (the two `eod_entries`/`eod_submissions` triggers)
- `supabase/migrations/20260504173035_per_store_rls_hardening.sql` (`auth_can_see_store`)
- `src/screens/staff/lib/types.ts`, `src/screens/staff/hooks/useEodSubmit.ts`,
  `src/screens/staff/lib/eodQueue.ts`, `src/screens/staff/store/useStaffStore.ts`,
  `src/screens/staff/screens/EODCount.tsx`
- `catalog_ingredients` RLS (`20260504060452`, `20260509000000`) for the `case_qty` read

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

None.

---

## Boundary-by-boundary verification (why each focus area is clean)

### 1. SECURITY DEFINER boundary preserved — CONFIRMED

- **Store-membership gate intact.** The in-body
  `if not public.auth_can_see_store(p_store_id) then raise ... errcode '42501'`
  guard survives byte-for-byte at
  `20260601000000_staff_submit_eod_cases_each.sql:111-114`, in the same position
  (after the vendor-presence check, before any INSERT) as the baseline
  `20260525000000_...:95-98`. `auth_can_see_store` is the canonical helper
  (`auth_is_admin() OR user_stores membership` —
  `20260504173035_per_store_rls_hardening.sql:31-41`). A staff user cannot write
  counts for a store they can't see; pgTAP assertion (6) exercises exactly this
  with a non-member store (Charles) + split keys present → `42501`
  (`staff_submit_eod_cases_each.test.sql:232-256`).

- **Actor derivation — no spoofing.** `v_actor` is still
  `coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown')`
  (`...:130`), so the per-user JWT wins over the caller-supplied `p_submitted_by`.
  The two hunks (recordset column list, INSERT column list) do not touch the
  actor logic. `eod_submissions.submitted_by` is additionally overridden to
  `auth.uid()` unconditionally by the BEFORE INSERT/UPDATE trigger
  `eod_submissions_set_submitted_by_trg`
  (`20260514120030_eod_submissions_consistency.sql:78-94`) — a tampered client
  payload cannot attribute a row to another user.

- **Signature unchanged → GRANT preserved.** The function is re-emitted with the
  identical 7-arg signature `(uuid, uuid, date, text, text, jsonb, uuid)` via
  `create or replace` (`...:70-77`), and the GRANT block is deliberately NOT
  re-emitted (`...:254-260`), so `GRANT EXECUTE ... TO authenticated` +
  `REVOKE ... FROM public, anon, service_role` from `20260525000000_...:221-222`
  survive untouched. pgTAP assertion (1) pins GRANT survival via
  `has_function_privilege('authenticated', '...(uuid,uuid,date,text,text,jsonb,uuid)', 'EXECUTE')`
  (`...test.sql:112-119`). The test correctly avoids a `set role anon` probe
  (spec 067 CI-segfault), using `throws_ok` for the 42501 gate instead.

- **Triggers still fire.** Both `eod_entries` triggers
  (`eod_entries_check_store_trg` cross-store match, and the submitted_by override)
  are `BEFORE INSERT/UPDATE FOR EACH ROW` and are agnostic to which columns the
  INSERT lists (`20260514120030_...:104-138`). Adding two columns to the INSERT
  column list does not change the trigger predicates — the cross-store-item guard
  continues to raise `42501` on a mismatched item.

### 2. The two new values are client-controlled — CONFIRMED SAFE

- **No SQL-injection surface.** The values are read via
  `jsonb_to_recordset(p_entries) as x(... actual_remaining_cases numeric,
  actual_remaining_each numeric ...)` (`...:178-186`) — type-coerced to `numeric`
  by Postgres, never string-interpolated into dynamic SQL. There is no `EXECUTE`
  / `format()` in the function body. A non-numeric jsonb value fails the
  `numeric` cast at parse time; it cannot become a SQL fragment.

- **Cannot write another store's `eod_entries`.** Entries are inserted with
  `submission_id = v_submission_id`, where the parent submission is gated by
  `auth_can_see_store(p_store_id)` AND the `eod_entries_check_store` trigger
  re-asserts `inventory_items.store_id == eod_submissions.store_id` per row.
  The two new columns ride on the same row as the existing total — they add no
  new write target and no new way to cross a store boundary.

- **Splits cannot corrupt `current_stock`.** The vendor-scoped inventory write
  still uses the total only:
  `set current_stock = v_entry.actual_remaining, eod_remaining = v_entry.actual_remaining`
  (`...:210-215`) — the raw `_cases`/`_each` splits are never read into
  `current_stock`. Verified there is no other code path (report or otherwise)
  that reads the split columns: a repo-wide grep for
  `actual_remaining_cases`/`actual_remaining_each` finds them only in the staff
  slice and the new RPC/test — no report RPC, no log, no audit string consumes
  them.

### 3. No new data exposure — CONFIRMED

- **RPC return shape unchanged** — `{ submission_id, conflict, entry_ids,
  stock_updates }` (`...:245-250`); `stock_updates` carries `new_stock` (the
  total), not the raw splits.
- **Audit-log value unchanged** — still renders
  `v_entry.actual_remaining::text || ' ' || coalesce(v_entry.unit, ci.unit, '')`
  (`...:234`): the total + unit, no PII, no raw splits.
- The two new columns are only ever persisted to the nullable
  `eod_entries.actual_remaining_cases` / `.actual_remaining_each`. No new field
  is added to any API response, log line, or error message.

### 4. Backward-compat path is not an auth bypass — CONFIRMED

A `p_entries` element omitting the two keys yields NULL via `jsonb_to_recordset`
and inserts NULL into the nullable columns (`...:193-198`); pgTAP assertion (4)
proves this (`...test.sql:183-208`). The legacy path runs through the SAME
`auth_can_see_store` gate and the SAME triggers — omitting the split keys does
not skip any check. The admin direct-PostgREST upsert (`db.ts submitEODCount`,
which never goes through this RPC) is unaffected.

### 5. Queue `:v1 → :v2` migrate cannot forge actor/store — CONFIRMED

The migrate (`eodQueue.ts:130-231`) is device-local AsyncStorage transform only;
it preserves `intent_user_id`/`store_id`/`vendor_id` from the v1 payload and maps
the old `count` to a units-only legacy shape. Tampering with the device-local
queue buys nothing at the trust boundary:
- The drain loop SKIPS any item whose `intent_user_id !== auth.uid()`
  (`useEodSubmit.ts:142-145`) — a forged `intent_user_id` for another user is
  simply not drained by the attacker's session.
- Even if a tampered `store_id` reaches the RPC, the server-side
  `auth_can_see_store(p_store_id)` gate refuses it with `42501`.
- The actor written to `audit_log` and `eod_submissions.submitted_by` is
  re-derived from `auth.uid()` server-side regardless of payload contents
  (RPC `...:130` + the submitted_by trigger).
The "RPC re-derives the actor server-side regardless" reasoning holds: a tampered
queue payload cannot spoof attribution or cross a store boundary.

The migrate's idempotency guard (skip when v2 is non-empty,
`eodQueue.ts:164-167`; write-then-remove ordering, `...:225-226`) is a
correctness/data-loss property, not a security one — out of my lane (correctness
is the test-engineer's / code-reviewer's call), and it reads correct.

### Incidental confirmation (not a finding)

The architect's PIN 1 (source column is `catalog_ingredients.case_qty`, not
`inventory_items.case_qty`) is correct: `inventory_items.case_qty` was added in
`20260502071736_remote_schema.sql:83` but DROPPED in
`20260504072830_brand_catalog_p3_lockdown.sql:62`; the live column is
`catalog_ingredients.case_qty` (`20260504060452:40`, present in `seed.sql:254`).
The staff query `catalog:catalog_ingredients(name, unit, case_qty)`
(`EODCount.tsx:124`) is valid and reads under the existing
`brand_member_read_catalog_ingredients` SELECT policy
(`20260509000000:446`) — the same brand-membership gate the staff JWT already
passes for the `name`/`unit` columns it reads today. No new RLS surface.

### Dependencies

No `package.json` change in the diff — `npm audit` skipped (no new dependencies,
consistent with the spec's "no new deps" claim). `git status` confirms only
`src/screens/staff/*`, `e2e/*`, `tests/README.md`, the new migration, and the new
pgTAP test changed.

---

## Summary

Spec 086 is a clean, additive change with no security findings at any severity.
The SECURITY DEFINER boundary on `staff_submit_eod` is fully preserved: the
in-body `auth_can_see_store(p_store_id)` store-membership gate, the
`auth.uid()`-wins actor derivation, the unchanged 7-arg signature (so the
`authenticated`-only GRANT and the `public/anon/service_role` REVOKE survive the
`create or replace` untouched, pinned by the pgTAP `has_function_privilege`
assertion), and both `eod_entries` consistency triggers all continue to fire on
the new INSERT. The two new values are read through `jsonb_to_recordset` and
coerced to `numeric` (no SQL-injection surface), only land in two nullable
`eod_entries` columns, and never reach `current_stock`, the audit string, the RPC
return, or any report — so there is no new data exposure and no way to corrupt the
total or write another store's rows. The backward-compat path (omitted keys →
NULL) runs through the identical gate and triggers, so it is not an auth bypass.
The device-local `:v1 → :v2` queue migrate cannot forge `intent_user_id` or store
because the drain skips foreign-`intent_user_id` items and the server re-derives
the actor and re-checks store membership regardless of payload contents. No
Criticals — nothing blocks this spec from advancing.
