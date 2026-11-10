# Spec 194: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-11-09. Read-only review. Status not changed.

## What I checked

- `supabase/migrations/20261109170000_kept_records_delete_hardening.sql`, compared with D-1 to D-9.
- `supabase/tests/kept_records_delete_hardening.test.sql` (103 assertions), compared with D-8.
- `src/lib/db.ts`: `upsertVendorDraftOrder` (L1808-1953) and `deletePoItem` (L1991-2016) only, compared with D-5.
- `src/lib/db.deletePoItem.test.ts`, the spec 194 hunks in `src/lib/db.upsertVendorDraftOrder.test.ts`, and `removePoLine` in `src/store/useStore.ts` (L3933-3947, unchanged).
- The neighbouring migrations on disk: `20261108120000` (186), `20261108130000` (187), `20261109120000` (189), `20261109140000` (190). I also checked the slots other specs have reserved but not yet written.
- D-11 (prod apply) against the objects that were actually built.

## Verdict

The build matches the design. I found no Critical findings: no contract drift, no RLS gap, and nothing bypasses `db.ts`. There are 2 Should-fix findings, both about verification or the prod runbook, not code. There are 5 Minor findings.

### Design conformance (no drift)

| Design item | Built | Match |
|---|---|---|
| D-1 #1 `kept_record_lock_date()`: SECURITY INVOKER, `search_path=public`, TG_ARGV check fails closed with P0001, jsonb pass-through comparison, claims-GUC server-context test, then `auth_is_privileged()`, then `42501 '%: % is immutable'` | migration L58-99 | Exact, including the order of the checks |
| Three date triggers, BEFORE UPDATE OF `<col>`, FOR EACH ROW, with the column as argument | L117-133 | Exact |
| D-1 #2 return-to-draft guard, no exemption | L137-167 | Exact |
| D-1 #3/#4 `po_id` / `import_id` locks, no exemption | L171-230 | Exact. The messages match the D-3 table byte for byte |
| D-1 #5/#6 RESTRICTIVE DELETE policies, no `TO` clause | L234-257 | Exact `qual`. C-1b pins the deparsed form |
| D-1 #7 revoke EXECUTE from public, anon and authenticated, plus comments | Present for all 4 functions and both policies | Yes |
| D-9 comment rewrite | L261-268 | Only the "Not a security boundary" sentence was replaced. The prefix and the last sentence are kept. Trigger names are correct for each table |
| D-6 trigger order | `po_items_check_store_trg` < `po_items_lock_po_id_trg`, pinned by C-3 | Yes. T09 is unchanged (per the implementation notes, 100/100 pass) |
| D-5 `deletePoItem` | `delete({count:'exact'})`, throws the D-3 string only on an explicit `0`; a null count succeeds | Exact |
| D-5 `upsertVendorDraftOrder` | `delete({count:'exact'}).in('id', oldIds)`, returns `null` and skips the `total_cost` update when `count < oldIds.length`; a null count keeps the old path | Exact |
| D-10 no change to useStore, UI, edge functions, publication or `config.toml` | Confirmed. `removePoLine` already reverts and calls `notifyBackendError('Remove PO line', e)` | Yes |
| Bypassing `db.ts` | Grep: no `po_items`/`pos_import_items` delete exists outside `db.ts` in `src/`, the staff subtree, `extension/src`, `supabase/functions`, `e2e` or `scripts` | None |
| R4 "no app path moves a PO into draft" | Grep of migrations, functions, `src` and the extension: only `po_loop.sql:89` (it runs earlier in migration order) | Holds |

The test file carries out every D-8 group. In places it goes further than the design: C-2 also pins `tgargs` and the bound function, C-2b pins that there is no DELETE trigger on the line tables, and AC-13 has a positive control for the brand-B principal. The AC-33 mutation table in the implementation notes is complete, and each mutation turned the expected arms red.

---

## Should-fix

### S-1. No fresh-database proof yet, for this migration or its current neighbours

The implementation notes ("Local apply") say the migration was applied with `psql -f` to an already-running stack, and the version was inserted by hand. The 100/100 pgTAP run then ran on that database. Nothing has yet:

- replayed the migrations in filename order from empty with the seed loaded afterwards, through the CLI's batch executor, or
- run 187 (`20261108130000`), 189 (`20261109120000`), 190 (`20261109140000`) and 194 together from scratch. Each of these was also applied piecemeal by its own session.

Spec 190's architect review (`specs/190-po-number-sequence/reviews/backend-architect.md` L163-171) asks for the same thing for the same reason. CI will be the first fresh build. Per CLAUDE.md, a local-green / CI-red split went unnoticed for days on spec 060.

A related point: the notes say `npx supabase status` fails locally with `[inbucket] ... no longer supported`. That suggests the local CLI is newer than the 2.108.0 pin (project memory: db-migrations gate CLI pin), so a plain local `npx supabase db reset` may fail the same way.

**Ask:** before push, run `npx supabase@2.108.0 db reset` (or whatever version `test.yml` pins), then the full `bash scripts/test-db.sh`, and record the result in the spec. If the owner chooses to let CI be the first fresh build instead, write that down so the AC-36 gate check is understood to be the real proof. I expect no code change: 194 uses the same `begin; ... $$ ... commit;` shape as its neighbours, and `seed.sql` has no UPDATE or DELETE on the five tables (grep: 0).

### S-2. D-11 does not verify everything that was built

This is a gap in my own design text, not a mistake by the developer. The build's own catalog arms are stricter than D-11, so the prod verification should use them.

1. **Triggers (D-11 step 4).** D-11 lists name, `tgenabled`, `tgtype` and `tgattr`. The three date triggers share one function and differ only in `tgargs`. A trigger with the right column list but the wrong argument would fail closed (P0001) or check the wrong column, and D-11's list would not catch it. **Use the C-2 query from the test file (test L307-326) verbatim on prod**, and expect the same 6-row string as local. It is read-only.
2. **Policies and comments (D-11 step 4).** Run the C-1a, C-1b and C-5 queries (test L268-303, L366-379) on prod. Also compare md5s of all five policy comments (the 3 rewritten and the 2 new ones) against local.
3. **Functions (D-11 step 4).** The C-4 query (test L350-363) covers `prosecdef`, `proconfig` and anon/authenticated EXECUTE in one row each. Keep the normalized-md5, owner and `proacl` checks D-11 already lists.
4. **Prerequisite (D-11 step 0).** Spec 186's prod apply (2026-11-10 03:29 UTC, `specs/186-retention-purge-server-job.md` L820-840) recorded the three comment md5s `19b31c66…` (purchase_orders), `3e6fcbcc…` (waste_log) and `27bd32e4…` (pos_imports). Check these again just before applying 194. The rollback SQL in the implementation notes restores the comment text from the repo file, so prod's pre-194 text must be byte-identical to the file, or the rollback would silently restore different text.

**Ask:** amend D-11 steps 0 and 4 as above before the owner's go-ahead. Do not change any code.

---

## Minor

### M-1. Two `upsertVendorDraftOrder` comments are now slightly stale

- `src/lib/db.ts:1805-1806`, the doc comment: "Returns ... `null` on empty lines / RLS denial / insert failure". It should also say "or when the old-line delete removes fewer rows than captured (spec 194: the PO left draft)".
- `src/lib/db.ts:1889-1890`: "A failure here leaves a recoverable doubled-lines state that the next Fill cart collapses." That is only true while the PO is still a draft. In the D-5 race the next Fill cart does not match a `sent` PO. The spec 194 block that follows explains this, so this is a wording fix only.

### M-2. The row-count check also catches a draft-on-draft race, which is fine but should be written down

`count < oldIds.length` also trips when two Fill carts (or a Fill cart and an export recording) run on the same draft that is still a draft. Both read the same old ids, the first delete removes them, and the second gets `0`. Before this change the second call returned `poId` silently. Now it returns `null`, and the user sees the "Draft not created" toast, while the draft holds both new line sets until the next Fill cart collapses them. The outcome is louder and still recoverable, and it matches D-5's intent. `deletePoItem` behaves the same way when the line was already deleted from another tab, which D-5 already accepts. **Ask:** add one sentence to the implementation notes so the release coordinator does not read it as a regression.

### M-3. Migration ordering: on-disk neighbours are fine, and two reserved slots sort earlier

On disk, in order: `20261108120000` (186), `20261108130000` (187), `20261109120000` (189), `20261109140000` (190), `20261109170000` (194). None of 187, 189 or 190 shares an object with 194:

- 190 adds a BEFORE INSERT trigger and a sequence on `purchase_orders`. 194's triggers are BEFORE UPDATE OF specific columns.
- 189 only reads `purchase_orders`.
- 187 touches `order_approvals`.

Reserved but not yet written: `20261109000000` (spec 188) and `20261109160000` (spec 195) sort **before** 194. `20261109190000` (193) and `20261109191000` (191) sort after it. If 188 or 195 is applied to prod after 194, prod's version history will be out of order. The MCP apply path and the drift gate (which checks set membership) both tolerate that, and neither spec overlaps with 194:

- 188 only inserts into `pos_imports`/`pos_import_items`. Its `recipe_id ON DELETE SET NULL` action updates only `recipe_id`, so the `UPDATE OF import_id` trigger does not fire.
- 195 touches only `user_stores` policies and leaves `auth_can_see_store()` unchanged.

Both specs already say to re-pick their slot at build time. No action for 194.

Note for future authors: C-1a pins the full list of 20 PERMISSIVE policies on the five tables. Any later spec that adds a policy to those tables must update this file on purpose. That is the intended behaviour (AC-28).

### M-4. Spec 186's migration is committed and on prod, not still in flux

The dispatch said `20261108120000` may still be uncommitted. On the evidence available:

- HEAD `15aefc4` is the spec 186 commit.
- The session-start `git status` has no entry for that path.
- Spec 186 records a prod apply on 2026-11-10 of body md5 `3a9076d7aaeab0c34fb8c0dedbef0094`.
- The three comment strings that 194 overwrites match the current file byte for byte, as I confirmed against the rollback SQL.

I could not run `md5`/`git` in this review (read-only tools). **Ask:** before 194's prod apply, run `md5 -q supabase/migrations/20261108120000_retention_prune_job.sql` and confirm it equals `3a9076d7…`. This goes with S-2 item 4.

### M-5. Record the version in the same transaction as the body

The migration ends with `commit;`, so a `schema_migrations` insert sent after it in the same `execute_sql` runs in its own transaction. Spec 186's apply ran both in one transaction (186 spec L830). Do the same for 194: paste the `insert into supabase_migrations.schema_migrations (version, name) values ('20261109170000', 'kept_records_delete_hardening');` just before the final `commit;` in the text sent to MCP. Function bodies do not change, so the normalized md5 is unaffected. This is optional (it is the same note as spec 190 review M-3).

---

## Not findings (checked and fine)

- The D-2 exemption: the pgTAP AC-8 arms cover a SECURITY DEFINER function, `postgres` with staff claims, `postgres` with no claims, and `service_role`. Each passes or raises as D-2 states.
- Legacy `request.jwt.claim.role` is read first. Current PostgREST does not set it, and no SECURITY DEFINER function in the repo calls `set_config` on it.
- The trigger functions keep EXECUTE for `service_role` under default privileges. That is harmless: a `returns trigger` function cannot be called directly, and C-4 pins anon and authenticated, as designed.
- The `npm run typecheck` failure in the implementation notes is caused by local duplicate folders `node_modules/@types/* 2`, not this change. CI installs from scratch, so it does not see them. The owner should know, but it is not a 194 issue.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 7 findings by severity: Critical 0, Should-fix 2 (S-1: no fresh-database proof yet, so run `npx supabase@<pinned CLI> db reset` plus the full pgTAP suite or record that CI is the first proof; S-2: amend D-11 so the prod check reuses the test's C-1/C-2/C-4/C-5 catalog queries, including `tgargs`, and re-confirms spec 186's comment md5s), Minor 5 (stale comments in `upsertVendorDraftOrder`, write down the draft-on-draft race behaviour, slots 188 and 195 sort before 194 but do not overlap, confirm spec 186's file md5 before apply, record the version inside the apply transaction).
payload_paths:
  - specs/194-kept-records-delete-hardening/reviews/backend-architect.md
