# Spec 189: backend-architect post-implementation drift review

Reviewer: backend-architect, who wrote the design. Date: 2026-11-09. Read-only: I had no shell, so I ran no psql or git diff. This covers only spec 189's hunks in the files named in the dispatch.

**Verdict: no contract drift.** The migration, the writer, both wrappers, the grants, `submitEODCount`, `buildEodChangeSet` / `planEodSubmit`, `submitEOD`, and the section all match §2–§9 and §13. I accept all five reported departures (rulings below). There are 0 Critical, 2 Should-fix, and 6 Nits.

## Critical

None.

## Should-fix

**S1. pgTAP arm (96) can't fail for the regression it names.** See [admin_submit_eod.test.sql:1148-1156](../../../supabase/tests/admin_submit_eod.test.sql).
- The arm counts `EOD entry` rows with `user_id = '1111…'` and `detail not like 'Count cleared%'`.
- The writer's per-entry branch always inserts `user_id = NULL` ([migration:258-261](../../../supabase/migrations/20261109120000_admin_eod_replace.sql)). So suppose `admin_submit_eod` started passing a non-NULL `p_audit_actor` (the doubled-audit regression AC-24 guards). The rows it wrote would have `user_id IS NULL`, and the arm would still read 0.
- Fix: stores `…a3` and `…a4` only ever receive admin calls with no removals. Count every `action = 'EOD entry'` row in those two stores, whatever the `user_id`, and expect 0.

**S2. §13 rollback is executable, but its text is incomplete for the runbook.** This is my design's gap, not the developer's. It is executable against what was built. Run `create or replace staff_submit_eod` with the 20261024000000 L103-316 body, then `drop function admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])`, then `drop function eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)`. That order works because plpgsql records no dependency, so the staff body must be replaced first. Amend §13/§14 before anyone needs it:
- **(a) Where the comment lives.** The comment to restore is at `20261024000000` **L1001-1002**, outside the L103-316 body range.
- **(b) Spec 193.** Spec 193 (`20261109190000_staff_eod_date_bound.sql`, provisional) re-replaces `staff_submit_eod` on top of 189's wrapper. If 193 has landed, restoring the 20261024000000 body silently drops 193's date bound. The rollback must then fold 193's check into the restored body. Otherwise roll 193 back first.
- **(c) What a rollback actually leaves.** With the client reverted and the index kept, every admin re-submit of an existing pair fails with 23505. In effect, admin count correction is unavailable until a forward fix. O-1 (empty refusal) and the staff null-total guard also revert. State all three so nobody reads "rollback" as "back to working".
- **(d) Same-PR obligations.** Delete `supabase/tests/admin_submit_eod.test.sql` in the same PR, or `test.yml` goes red. The rollback migration needs its own version, sorting after the newest file on disk, and its own `schema_migrations` insert on prod.

## Nits

**N1. Stale fixture comments** in [report_last_order_context.test.sql:263](../../../supabase/tests/report_last_order_context.test.sql) ("the anchor whose ONE submission holds TWO entries for one item") and L277 ("the duplicated-count item"). The fixture at L334-344 and the arm comment at L628-633 were rewritten, but these two weren't.

**N2. Pre-flight and AC-32 query disagree on NULLs.** The pre-flight ([migration:84-92](../../../supabase/migrations/20261109120000_admin_eod_replace.sql)) excludes NULL `submission_id` / `item_id`, which is correct, because the index keeps NULLs distinct. AC-32's runbook query doesn't. So a NULL-`item_id` group would trip "stop and ask the owner" at §14 step 1 without blocking the migration. Add `where item_id is not null` to the runbook copy, or note that NULL-item groups are benign.

**N3. A removal-only call that removes nothing is not refused.** This applies to `p_entries = '[]'` with `p_removed_item_ids` naming only ids absent from the submission, or `{NULL}`.
- It passes Rule A (cardinality ≥ 1) and Rule B (existing rows remain).
- So it bumps `submitted_at` and emits an `eod_update` while changing no entry.
- Only privileged callers can do this, and `admin_update_eod_submissions` already allows the same bump.
- The client can reach it: if a colleague deleted a baseline row before this manager's removal, the change set names it.
- Harmless, but §3.4's "nothing changes, including `submitted_at`" doesn't strictly hold. Optional fix: raise 22023 when the targeted delete and the entries loop both touch 0 rows.

**N4. The staff on-hand UPDATE now writes `last_updated_by = coalesce(NULL, ii.last_updated_by)`** ([migration:244-252](../../../supabase/migrations/20261109120000_admin_eod_replace.sql)). The value is unchanged, but the column is now in the SET list. I grepped for `update of … last_updated_by` triggers and found none today. A future column-scoped trigger on that column would start firing on the staff path. No action. Worth a one-line comment if anyone adds such a trigger.

**N5. No lock is held between the pre-flight and `create unique index`.** A concurrent stacked insert in that window makes the index build fail with a bare 23505 instead of the named message. The outcome is the same: the transaction rolls back. Ignorable given that prod has no traffic on this path.

**N6. The toast count is computed locally (`resultCount`, [EODCountSection.tsx:979-982](../../../src/screens/cmd/sections/EODCountSection.tsx)), and the server's `entry_count` is ignored.** They differ only if a colleague added rows since the baseline. The design said callers may ignore the return, so this isn't drift, just a free accuracy win if anyone touches it.

## Rulings on reported departures

| Departure | Ruling | Why |
|---|---|---|
| `admin_submit_eod` refuses a non-array `p_entries` even with removals present | **Accept** | §3.4 Rule A only named the empty case, but the writer's `jsonb_to_recordset` would raise 22023 on a non-array anyway, *after* the parent upsert. Refusing up front keeps §3.1's "every refusal fires before any write". Arm (72) pins it |
| `entry_count` = the submission's entries after the call | **Accept** | §3 left the semantics open. The post-call total is the value Rule B already computes and is the more useful one. No client reads it |
| `Count cleared` value uses `trim_scale`, and is `''` for a legacy null total | **Accept** | The stored column is scaled (`5.000` in arm 19), while the original audit rows used unscaled values (client `${n} ${unit}`, staff `jsonb` numeric → `5 lbs`, arm 23). Trimming keeps the cleared value comparable with the row that recorded it. `''` mirrors the client's SF-3 empty value for a non-numeric, non-NO-NEED entry |
| `stock_updates` keeps off-vendor entries, drops NO NEED and null-total | **Accept** | That is §6 exactly: one predicate "also gating `stock_updates`". The off-vendor inclusion is the pre-189 behaviour, kept byte-for-byte. I grepped `src/` and nothing consumes `stock_updates` |
| Frontend: the removal arm requires the baseline row to have shown a count under the live mode | **Accept, with one residual** | This fills a gap in my §5 rule. Without the guard, a note-only edit on a row whose saved value sits in a mode-disabled box reads as "blank, baseline present" and **deletes a count the manager never saw**, which breaks D-4. The guard is the correct tie-break. Residual: that note edit is dropped silently. If it's the only change, `planEodSubmit` returns `noop` and the success toast shows. This needs a count-mode change after the count *and* a note-only edit. Pinned by [eodChangeSet.test.ts:175](../../../src/lib/eodChangeSet.test.ts). Recommend a named follow-up (an info toast, or a server carry that preserves stored numerics), not a blocker |

## Checks requested

**Migration step order and locks.**
- The order is pre-flight (L80-99), index (L102), writer (L124), `staff_submit_eod` (L301), `admin_submit_eod` (L408), then forward comments (L515, L518). This matches §1.
- Grants sit next to each function rather than in a final block. That's equivalent inside one transaction.
- `set local lock_timeout = '5s'` sits inside `begin; … commit;`, the repo convention (37 other migrations use the same wrapper, including 186/187/190/194).

**Writer order.**
- (1) The parent upsert names `status` and `submitted_at` in DO UPDATE, keeping the `notify_eod_resubmission` trigger columns and the pre-count `current_stock` read (§7).
- (2) Then removals. The targeted branch deletes named removals with one `Count cleared` row each via a data-modifying CTE, then deletes rows named in `p_entries`. The NULL branch does a full delete.
- (3) Then the loop.
- This matches §2 and §7.

**`staff_submit_eod` envelope.**
- The conflict envelope is verbatim (L358-362 vs 20261024000000 L174-178).
- The success envelope is built by the writer with the same four keys and the same `jsonb_build_object` (L280-285 vs L309-314). Arm (16) pins the keys.
- Steps 1, 1.5, 3 and 4 are verbatim. Step 2's vendor lookup moved into the writer, which is not observable.
- The staff audit expression is verbatim.
- The only content change is null-total omission from `stock_updates`, which is designed (§6).
- O-1 sits after step 4 and before the writer, per §10.

**Grants (§9).**
- Writer: `revoke all … from public, anon, authenticated, service_role` (L294-295). The owner keeps EXECUTE, which is what both definer wrappers run as.
- Admin: revoked from `public, anon, service_role`, granted to `authenticated` (L509-512).
- Staff: `create or replace` with the same signature, so the ACL carries over. Arm (12) pins `f|t|f`.
- Arms 1-12 cover `prosecdef`, `proconfig` and `has_function_privilege` for all three roles on both new functions.

**Forward comments (§9).**
- `comment on table public.eod_entries` is new. I grepped and found no prior table comment, so nothing is lost. The 20260514120030 file is left alone, per the design.
- `comment on function report_last_order_context` restates 20260803000000 L349-368 verbatim and appends the 189 correction. The body isn't re-created, so its normalized md5 is unchanged.

**Pre-flight.** It is correct. It raises 23505 with a message naming §14 step 1 and the local remedy. See N2 and N5.

**Rollback.** It is executable. See S2 for the text the runbook needs.

**DB access.**
- `submitEODCount` ([db.ts:1039-1077](../../../src/lib/db.ts)) is one `supabase.rpc('admin_submit_eod')` call inside `track(…, { kind: 'write' })`, with entries sorted by item id. It doesn't send `submitted_by`, and it maps to `{ submissionId, entryCount }`. This matches §13.
- No direct `eod_entries` / `eod_submissions` / `inventory_items` write remains in `db.ts`. The only `eod_entries` mentions left are the read embeds at L1099, L1152 and L1217.
- `EODCountSection` and `eodChangeSet.ts` don't touch `supabase` directly.
- The jest `afterEach` in `db.eodNoNeed.test.ts:238-242` enforces this (AC-21).

**Store.**
- `submitEOD(submission, opts?) => () => void` matches §8.
- The merge drops `removedItemIds` (AC-23).
- `db.adjustItemStock` is gone from this path. Its only remaining caller is `adjustStock`, at useStore.ts:2662.
- The undo restores the row and the four mirrored on-hand fields. Audit and bell are not undone (D-5).
- The "third copy" comments are rewritten (N3 of the spec).

**Version collision.**

Files on disk with 2026-11-0x versions:

| Version | Spec | Notes |
|---|---|---|
| `20261105000000` | 184 | |
| `20261108000000` | 178 | |
| `20261108120000` | 186 | |
| `20261108130000` | 187 | |
| **`20261109120000`** | **189** | Unique |
| `20261109140000` | 190 | |
| `20261109170000` | 194 | |

- Spec 188's reserved `20261109000000` isn't on disk. Spec 195 plans `20261109160000` and spec 193 plans `20261109190000`.
- None of 190, 194 or 195 touch `eod_entries`, `eod_submissions`, `staff_submit_eod` or `inventory_items` writes. I checked 194 specifically: its restrictive DELETE policies are on `po_items` / `pos_import_items` only.

Prod runbook ordering:
- Apply 189 after 187 and before 193, which depends on it and whose md5 pre-check must use the **post-189** `staff_submit_eod` body.
- If 190 or 194 reaches prod first, 189 goes in out of version order. That is fine through MCP `execute_sql` plus the exact `schema_migrations` insert, because `db-migrations-applied.yml` is a set comparison. `supabase db push` / `migration up` would need `--include-all`.
- Local stacks that already hold `20261109140000` (applied by another session) need the same, or psql as the developer did.
- A fresh `db reset` runs file order with no cross-dependency, so it's safe.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 8 findings by severity: 0 Critical, 2 Should-fix (S1 the AC-24 pgTAP arm 96 can't fail; S2 the §13 rollback text needs the spec 193 interaction, the comment location, the post-rollback state and the same-PR test deletion), 6 Nits. I accepted all five reported departures.
payload_paths:
  - specs/189-admin-eod-resubmit-replace/reviews/backend-architect.md
