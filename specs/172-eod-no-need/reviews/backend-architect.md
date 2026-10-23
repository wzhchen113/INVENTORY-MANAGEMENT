# Spec 172: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-10-23. Scope: the staged working tree (HEAD `21effa6`, spec 171 committed) compared with `## Backend design` §0-§13 in [specs/172-eod-no-need.md](../../172-eod-no-need.md). I read the files directly. I ran no commands, so I did not recompute the md5 values myself.

## Verdict

**No contract drift, and no Criticals.** The migration matches the design hunk for hunk. The client data contract (types, `db.ts`, `useStore`, staff queue/RPC payload) and the AC-27 guards are implemented as designed. Two **Should-fix** items concern the prod deploy runbook, not the code. Both must be closed before the push.

## 1. Migration diff against latest owners

Sources:
- [20261024000000_eod_entries_no_need.sql](../../../supabase/migrations/20261024000000_eod_entries_no_need.sql)
- [20260630000200_staff_submit_eod_multi_vendor.sql:56-247](../../../supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql)
- [20260726000000_reorder_drop_inbound_term.sql:42-681](../../../supabase/migrations/20260726000000_reorder_drop_inbound_term.sql)

**Latest-owner check.** A grep over every `create or replace function public.(report_reorder_list|staff_submit_eod)(` confirms nothing redefines either function after those two files.

### `staff_submit_eod`

The body is verbatim (L103-316 against the owner's L56-247). The only executable deltas are the five designed hunks:

| Hunk | Line | Change |
|---|---|---|
| S1 | L219-221 | `no_need boolean` added to the recordset |
| S2 | L235, L239 | `no_need` column, `coalesce(v_entry.no_need, false)` |
| S3 | L270 | `and not coalesce(v_entry.no_need, false)` |
| S4 | L293-294 | `case … 'NO NEED' else <old expression verbatim> end` |
| S5 | L301-306 | `if not … end if` around the append |

Everything else is identical:
- signature and `security definer`
- `set search_path = public`
- the 22023 and 42501 gates
- the idempotency path
- the upsert
- delete-then-insert

Comment lines were added inside the body. That is fine: the §9 md5 is comment- and whitespace-normalized. Grants are deliberately not re-emitted, as designed. Posture is pinned by `eod_no_need.test.sql` (11)-(18) and by `staff_role_eod_rls.test.sql` (10) for service_role.

### `report_reorder_list`

The body is verbatim (L319-999 against the owner's L42-681). Only the designed hunks differ:

| Hunk | Line | Change |
|---|---|---|
| R1 | L461-467 | `no_need_items`, reusing 4e's `(store, as_of_date, 'submitted')` filter |
| R2(a) | L545-546 | the join |
| R2(b) | L519-521 | the middle arm: `lev.submission_id is not null and nn.item_id is not null`, which is D7 exactly |
| R2(c) | L533-535 | the column |
| R2(d) | L527 | the `eod_missing_for_item` term |
| R3(a) | L732 | |
| R3(b) | L745-756 | the else-branches are the old `greatest(…)::numeric` verbatim |
| R4 | L810-812 | inserted after `eod_missing_for_item`, before `truncated` |

The function stays SECURITY INVOKER (no `security` clause, same as the owner), with `SET search_path TO 'public'`. Envelope keys are unchanged. `report_reorder_for_counted_onhand` is untouched.

### Column, CHECK, and migration header

- The column/CHECK/comment section and `lock_timeout` match §1.
- `begin; … commit;` follows the established repo idiom (28 migrations use it, including 171's).
- The header correctly says the realtime restart ritual does NOT apply (§7).

### Other SQL readers (N1 audit)

I grepped `coalesce(…actual_remaining…)` across migrations. The only hits are the inventory-count RPCs (`20260513000000`, `20260622090000`), which are out of scope.

- `report_last_order_context` (2f) filters `actual_remaining is not null`, so NO NEED is treated as "no count", as the spec assumed.
- No trigger on `eod_entries` reads `actual_remaining`. Only `eod_entries_check_store` exists.

## 2. Client contract

| Surface | Design ref | Result |
|---|---|---|
| `EODEntry` ([types/index.ts:374-395](../../../src/types/index.ts)) | §6.1 | Matches: `actualRemaining: number \| null`, `noNeed?: boolean`. |
| `submitEODCount` ([db.ts:1015-1022, 1078](../../../src/lib/db.ts)) | §3.1 | Matches. `no_need` is sent on every row, which avoids the bulk-insert NULL / 23502 trap. Numerics are forced to null for NO NEED. `continue` comes before the membership check. |
| Three read mappers ([db.ts:1125/1152-1153, 1178/1203-1204, 1243/1270-1271](../../../src/lib/db.ts)) | §3.4 | Matches. `no_need` is selected. `actualRemaining` is null only when `no_need === true`, and the conditional spread adds `noNeed` only when true. Numeric rows are byte-identical. |
| `useStore.submitEOD` ([useStore.ts:3007-3039, 3064](../../../src/store/useStore.ts)) | §8 | Matches. The mirror and `adjustItemStock` run behind `numeric && itemMatchesSubmittedVendor`. The audit row uses `EOD_NO_NEED_AUDIT_VALUE`. All three on-hand writers (db.ts, RPC S3, store) now skip NO NEED, which closes the N2 "third copy" requirement. |
| `src/lib/eodNoNeed.ts` | §5 | Exact surface. One documented extension: `numericEodSubmissions` passes `entries: undefined` through by identity. The signature is unchanged, so this is acceptable. |
| Staff `EodEntry` ([staff/lib/types.ts:89-95](../../../src/screens/staff/lib/types.ts)) | §6.3 | Matches. |
| `isValidEodEntry` ([eodQueue.ts:57-74](../../../src/screens/staff/lib/eodQueue.ts)) | §6.3 | Matches. It accepts exactly two shapes, rejects NO NEED carrying a number, and does not bump the queue key. |
| `entriesForRpc` ([useEodSubmit.ts:70-93](../../../src/screens/staff/hooks/useEodSubmit.ts)) | §6.3 | Matches. The `no_need` spread is added only for NO NEED entries, so the numeric payload is byte-identical. |
| `fetchExistingSubmission` / `seedFromExisting` ([EODCount.tsx:227-273, 538-564](../../../src/screens/staff/screens/EODCount.tsx)) | §3.5 | Matches. The staff-subtree direct `supabase.from` is the documented CLAUDE.md carve-out. |
| AC-27 sites | §12 | All six `cmdSelectors` functions strip via `numericEodSubmissions` (L32, L364, L473, L521, L622, L1036). The `entries.length` proxies at L669 and L1040 read the stripped list. `usageCalculations.buildReconciliationLines` strips once (L186) and passes `numericSubs` to the private `getOpeningStock` (retyped `NumericEODSubmission[]`; no other callers). `ReconciliationSection` guards L157, L287, and L378. The remaining `actualRemaining` readers are null-safe or use other types: `EODCountSection` L162/L2220, `countHistoryPar`, and `InventoryCountSection`, which uses a different entry type. |
| Frontend use of helpers | §12 | The EOD rows route through `eodRowCounted`, `eodRowEntryValues`, `eodToggleNoNeed`, `eodSetNoNeed`, and `eodTypeInto`. The reorder and export code uses the shared `REORDER_FLAG_NO_NEED`. `deriveCountedItemIds` gets arm (c) and keeps arm (b) unchanged. `localHasCount` feeds `estValue` and `variance` (AC-24). EDIT prefill uses the user-typed-wins rule. The admin `fetchReorderList` and staff `fetchReorder` mappers pass `flags` through as raw strings (db.ts L4738, fetchReorder.ts L75), so the new token reaches the UI. |
| `db.ts` bypass | Rule | None. `supabase.(from\|rpc)(` has no hits under `src/screens/cmd/`. |
| Realtime / edge functions | §4, §7 | No publication change and no function change. Both correct. |

## Findings

### Critical

None.

### Should-fix (deploy runbook; must close before `git push`)

**SF-1. The prod pre-check has not been run yet. It is the release gate.**

The implementation notes record local pre-172 normalized md5s:
- `staff_submit_eod` = `c7a6f37994683f2c8317c9ee3146fc42`
- `report_reorder_list` = `15eaff54265a3adb0f1bbd9283dea5e8`

They state that the §9 step-3 prod check was "local only this pass". The plan is sound:
- The formula strips comments, collapses whitespace, and lowercases, so it tolerates both the MCP `pg_get_functiondef` dump style and the repo style.
- 171 did not touch either function, so the local pre-172 state at `21effa6` is the correct baseline.

What is missing is execution. Before any apply:
1. Run §9 step 3 (a)-(d) against `ebwnovzzkwhsdxkpyjka`.
2. Require both md5s to equal the two values above. A mismatch means **STOP**: prod has undeclared drift, and the recreate would clobber it.
3. Require (a) to return only `20261023000000`.
4. Require (b) to return 0 rows.

After the apply:
- Require `41220a3f9a7629c0b13579af3d280020` / `395f8831dbcaf91edcaf3c59227821a2`.
- Insert the exact version `20261024000000` into `schema_migrations`. Do not use `apply_migration`.
- Only then commit and push, and check `test.yml`, `db-migrations-applied.yml`, and `e2e.yml`.

The deploy order is DB, then client. It is load-bearing (R1): the old RPC plus a new staff client writes `current_stock = NULL`. An old client against the new DB is harmless:
- the admin insert omits `no_need`, so the default `false` applies;
- the staff RPC coalesces an absent key to false;
- the `no_need` flag cannot appear until a new client writes a mark.

**SF-2. Reload the PostgREST schema cache unconditionally after the apply. The design's PGRST204 trigger is not observable on the read path.**

§9 step 5 runs `notify pgrst, 'reload schema'` only "if the admin insert returns PGRST204". But the three admin read mappers swallow errors: they `console.warn` and `return []`. A stale cache would therefore show as blank EOD views or a "no submissions" Dashboard, not as an error the operator would see. Hosted Supabase normally reloads on DDL, but the cost of being wrong is a silent blank screen on every admin client the moment the push deploys.

Amend the runbook:
1. After the MCP apply, always run `notify pgrst, 'reload schema';`.
2. Then verify through PostgREST, not SQL. `GET /rest/v1/eod_entries?select=no_need&limit=1` with an admin JWT must return 200, not 400 / PGRST204.
3. Only then push.

### Minor

**M-1. pgTAP assertion (5) is vacuous by construction.**

`supabase/tests/eod_no_need.test.sql:186-194` counts rows where `no_need is distinct from false` and a numeric is non-null. The CHECK added by the same migration makes that predicate unsatisfiable, so the assertion can never fail. AC-1 is still pinned by (3) NOT NULL, (4) DEFAULT false, and (10) omitted-column-reads-false; PG fills existing rows from the constant default. The developer's reason for scoping it (smoke residue) is valid. Fix: relabel (5) as a CHECK-consistency probe, or drop it, so it doesn't read as AC-1 evidence.

**M-2. Runbook §9 step 5 uses `\d public.eod_entries`, which MCP `execute_sql` cannot run** (it is a psql meta-command). Replace it with:
- `select pg_get_constraintdef(oid) from pg_constraint where conname = 'eod_entries_no_need_no_quantity_check';`
- `select column_default, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name = 'eod_entries' and column_name = 'no_need';`

Also add `not has_function_privilege('service_role', 'public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)', 'execute')` to the post-verify, mirroring the existing pgTAP pin. This is my own design's omission, not developer drift.

**M-3. A client rollback drops whole queued submissions.**

An older staff bundle's `hydrateQueue` filters out any queued submission that contains a NO NEED entry ([eodQueue.ts:116](../../../src/screens/staff/lib/eodQueue.ts)). It drops the **whole** submission, including its numeric sibling entries, not only the NO NEED element. The design calls this protective, and it is: it prevents the NULL on-hand write. But it is a silent loss of real counts on rollback. Record it in the rollback note (§9 step 7): drain the staff queues before rolling the client back, the same posture already stated for the DB rollback.

**M-4. `ReconciliationSection.tsx:157` shows `0 / 0` with "100% complete" on a day whose latest submission is all NO NEED.**

The numerator and denominator were already the same expression before 172, so this was a tautology. The numeric filter is correct per AC-27. The display is now misleading in that edge case. It is cosmetic and should become a follow-up, not a fix here.

**M-5. `scripts/smoke-staff-eod.sh` step 8b leaves a local residue.**

It primes a linked item's on-hand to 7 and leaves it there. The rest of the smoke behaves the same way, and the developer documented it. Noted only so nobody mistakes a local `current_stock = 7` for seed data.

**M-6. Confirming follow-ups already accepted in the design (§11 OQ-B / OQ-D), not drift.**
- `PhoneOrdering.tsx`, `reorderExport.ts`, and `reorderExportStaff.ts` still print the stale on-hand for a `no_need` row.
- The Dashboard `% 5 + 30` proxy at `DashboardSection.tsx:1278` counts NO NEED entries; the selector twins do not.
- The frontend's two pre-existing observations are unrelated to this diff: Ordering shows `0 vendors` until REFRESH, and the desktop locked meta line shows `· total 0`.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Should-fix | 2 (SF-1 prod pre-check not yet run; SF-2 unconditional PostgREST schema reload + REST probe before push) |
| Minor | 6 |

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix, 6 Minor findings. Both Should-fix items are runbook/deploy gates (run the §9 prod md5 pre-check, and reload the PostgREST schema cache unconditionally with a REST probe before push). They are not code drift.
payload_paths:
  - specs/172-eod-no-need/reviews/backend-architect.md
