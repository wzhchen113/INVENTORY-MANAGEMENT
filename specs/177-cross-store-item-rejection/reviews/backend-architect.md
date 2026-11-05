# Spec 177: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-10-26. Mode: post-implementation drift review. Status was left at `READY_FOR_REVIEW`.

## Files reviewed

- `supabase/migrations/20261025000000_cross_store_item_rejection.sql` (new)
- `supabase/tests/cross_store_item_rejection.test.sql` (new)
- `supabase/tests/order_approvals.test.sql` (AC-16 fixture edit)
- `supabase/tests/report_last_order_context.test.sql` (AC-16 fixture edit)
- The spec's `## Backend design` §0-§12 and `## Files changed`

## Verdict

**No Critical findings.** The migration matches the design contract in every area that matters to callers:

- trigger names, events and column lists;
- SECURITY INVOKER with `set search_path = public`;
- errcodes and the exact message strings (§4 table);
- comments and the three revokes;
- the `begin` / `set local lock_timeout = '5s'` / `commit` wrapper;
- the PROD-APPLY header.

The one reported deviation is accepted (see D-A below). The pgTAP file implements T01-T54 as designed, with `plan(54)`, and every `throws_ok` asserts both the SQLSTATE and the exact message. The two AC-16 fixture edits stay inside the allowance. There is no RLS, publication, edge-function or `src/**` drift.

I found two Should-fix items, both in **my own §10 runbook** and not in the developer's code. Main Claude should apply the corrected text below in place of the original when executing the runbook.

Counts: Critical 0, Should-fix 2, Minor 4.

---

## Assessment of the reported deviation (D-A): ACCEPTED

The change wraps the `jsonb_array_elements` argument in `order_approvals_lines_check_store()` step (1) (migration L143-149):
`case when jsonb_typeof(new.lines) = 'array' then new.lines else '[]'::jsonb end`.

- **It is correct and in the spirit of the design.** The §2 pseudocode broke its own "no AND/OR evaluation-order reliance" rule. If the OR's right arm ran first on a non-array `lines`, `jsonb_array_elements` would raise its built-in 22023 ("cannot extract elements from an object/scalar"). That error has the right SQLSTATE but the wrong message, so T38 would pin a message that was luck-dependent. With the CASE, the right arm sees `'[]'` and yields nothing, and the left arm alone decides.
- **Accepted and refused sets are unchanged.** For an array, the CASE is the identity. For a non-array, the left arm is already true. SQL NULL `lines` gives `jsonb_typeof(NULL) is distinct from 'array'`, which is true, so the check still fails closed with the stable 22023.
- **No other order reliance remains in step (1).** Inside the EXISTS, `jsonb_typeof(e) <> 'object' or not pg_input_is_valid(coalesce(e->>'item_id',''),'uuid')` is safe in either order: `->>` on a non-object jsonb (scalar or array) returns NULL rather than raising, and the result coalesces to `''`, which is invalid. So T41 (`["x"]`) cannot leak a different error.
- **Step (2) needs no guard.** Steps (1) and (2) are separate PL/pgSQL `IF` statements, so they run in sequence. Step (2) is only reached once (1) has proven `lines` is an array of objects with valid uuids, so its `::uuid` cast cannot raise 22P02.
- **Consequence for verification.** The design's §2 pseudocode no longer byte-matches the shipped body. The **migration file is the authority**, and the recorded normalized md5 `71491c6f…` is the hash of the CASE-wrapped body. Nobody should diff prod against the §2 pseudocode.

## Contract conformance (checked, no drift)

| Design item | Shipped | Result |
|---|---|---|
| R-1 `po_items_check_store()` + `po_items_check_store_trg` BEFORE INSERT OR UPDATE OF item_id, po_id | L60-116 | Matches. `v_item_store is distinct from v_po_store` vs the pseudocode's `<>` is equivalent, because `v_item_store` null is handled in the same predicate and `v_po_store` is non-null by that point. |
| R-2 two set-based statements, 22023 shape / 42501 store | L128-185 | Matches, plus D-A. |
| R-3 always immutable, 42501 | L193-220 | Matches D-3. |
| D-5 invoker + `set search_path = public` on all three | yes | T52 pins `prosecdef = false`. |
| D-6 guard fires first (name order) | trigger name `order_approvals_lines_check_store_trg` | T37 (P0001 guard message) and T54 pin it. |
| D-7 `create_order_approval` byte-identical | not re-created | Verified. All three write sites (L400 insert, L424 race-loser update, L437 retry update) fire the trigger. The 42501 is not `unique_violation`, so the L408 handler does not swallow it. A BEFORE INSERT trigger fires before the unique-index check, so a racing loser with bad lines gets 42501, not 23505. |
| R-5 revokes from `public, anon, authenticated` | L109, L178, L213 | T49-T51 also check that `proacl` is non-null and has no PUBLIC EXECUTE entry. |
| Strictly additive, no policy/publication change | yes | `drop trigger if exists` + `create or replace` make the file re-runnable. |
| PROD-APPLY header naming `20261025000000`, normalized-md5, `pg_trigger` `tgenabled = 'O'`, no realtime restart | L40-45, L25-26 | Matches. |
| FK actions that could fire the new triggers | `po_items.item_id` is plain `references inventory_items(id)` (init_schema L169, NO ACTION), never altered later | No SET NULL path fires R-1. The runbook pre-check re-verifies this on prod. |
| Other triggers on the three tables | `set_po_number` (BEFORE INSERT) and `notify_purchase_order` (AFTER) on purchase_orders; `order_approvals_guard` on order_approvals; none on po_items | Matches the Step 1 expectation text. |

pgTAP vs §9:
- T01-T54 are all present with the designed callers.
- T13 uses `reset role`, so the parent is visible and the null-store branch is exercised.
- T14 passes with the trigger's own message, which confirms that the BEFORE-row trigger runs before the RLS WITH CHECK, as designed.
- T19 goes through the real `receive_purchase_order`.
- The anti-vacuity arms (T01/T02) and the developer's negative control (32/54 fail with the triggers disabled) show the file has teeth.

AC-16 fixture edits:
- `order_approvals.test.sql` L104-119 adds only two brand-A `catalog_ingredients` rows and two `inventory_items` rows. They use the existing literal ids `49920000-…-0001/0002`, in `test.store_a` (Frederick in that file), placed in the postgres fixture block before the first `set local role`.
- `report_last_order_context.test.sql` L347-354 and L407 add only the comment and the `disable` / `enable trigger order_approvals_lines_check_store_trg` pair around the existing INSERT.
- I found no assertion, expected-value or `plan()` change in either file. I had no shell, so I could not run `git diff`. This was checked by reading the files and matching the developer's "additions only, 17 / 10 lines" claim. code-reviewer should confirm with `git diff --stat`.

---

## Should-fix

### S-1. Runbook §10 Step 2 gives two conflicting instructions. Run the file verbatim.
`specs/177-cross-store-item-rejection.md` L495 says to execute "the committed migration body verbatim (its own `begin; … commit;`)" and also to "prefer the exact pgTAP-tested function bodies (`pg_get_functiondef` dumped from local …)". That second sentence was carried over from the spec 172 runbook, where only function bodies changed. Here it is wrong. A `pg_get_functiondef` dump contains only the three `CREATE FUNCTION`s, so it would **drop the three triggers, three revokes and three comments**. The md5 check would then pass on prod while nothing actually fires.

**Corrected Step 2 (execute verbatim):** pass the full text of `supabase/migrations/20261025000000_cross_store_item_rejection.sql` exactly as committed, from line 1 to the final `commit;`, as a single MCP `execute_sql` call on project `ebwnovzzkwhsdxkpyjka`. Do not strip the header, the `begin;` / `set local lock_timeout` / `commit;`, or the comments.
- The same wrapper shape (`begin; set local lock_timeout …; commit;`) was used by `20261024000000_eod_entries_no_need.sql`, which was applied through MCP `execute_sql` in spec 172, so the transaction framing is proven on this path.
- The file is all-or-nothing. If it fails with `55P03 lock_not_available` (lock_timeout), nothing was created. Re-run the same call off-peak. It is safe to re-run because of `create or replace` and `drop trigger if exists`.

### S-2. Runbook §10 Step 5's probe cannot be run verbatim and relies on a cross-call transaction.
Step 5 has `<line.po_id>` / `<existing po_items.id>` placeholders. It also depends on `begin … rollback` holding inside the MCP session. If the trigger had **not** fired and the `rollback` were lost (for example, sent as a separate call), a real prod `po_items` row would be left pointing at another store's item. That is the exact corruption this spec exists to prevent.

**Replacement Step 5 (one `execute_sql` call, no placeholders, cannot persist a write):**
```sql
do $$
declare v_line uuid; v_po uuid; v_other uuid;
begin
  select pi.id, pi.po_id into v_line, v_po
    from public.po_items pi order by pi.id limit 1;
  select ii.id into v_other
    from public.inventory_items ii
    join public.purchase_orders po on po.id = v_po
   where ii.store_id is distinct from po.store_id
   order by ii.id limit 1;
  if v_line is null or v_other is null then
    raise exception 'PROBE SKIPPED: no po_items line or no other-store item';
  end if;
  begin
    update public.po_items set item_id = v_other where id = v_line;
  exception when sqlstate '42501' then
    raise exception 'PROBE OK: %', sqlerrm;
  end;
  raise exception 'PROBE FAILED: po_items_check_store_trg did not fire';
end $$;
```
- **Expected result:** an ERROR whose text is `PROBE OK: po_items: item store mismatch with parent purchase order`.
- **Every path ends in an exception**, so the DO statement is always rolled back as a whole and no row can persist, whether or not the trigger fired. It runs as postgres (RLS bypassed), so it proves the trigger fires regardless of caller.
- `PROBE FAILED` means STOP: report to the owner and do not push.
- `PROBE SKIPPED` means fall back to Step 4 plus the local pgTAP run, which is the documented reasoning step.
- Optional, same shape: an R-3 probe that updates `store_id` on any PO to another store's id inside the same raise-always DO. `notify_purchase_order` is AFTER UPDATE and never runs, because the BEFORE trigger raises first.

---

## Minor

### M-1. Recorded local md5s were not independently recomputed by this reviewer.
I had no shell in this review, so I could not re-derive `ec2c92ef…` / `71491c6f…` / `d357ad34…`. Step 4 already says to run the md5 queries both locally and on prod and compare. At apply time:
1. Re-run the three local md5 queries (`docker exec supabase_db_imr-inventory psql -At -c …`) against a local DB whose functions came from the **committed** file. Either use a fresh `npx supabase db reset`, or confirm the file has not changed since `npx supabase migration up --local`.
2. Check that the fresh local values equal the recorded ones. A mismatch means the file changed after the developer ran it, so re-run pgTAP before applying.
3. Check that prod equals local.

The normalization regex is safe for these bodies: no `--` appears inside a string literal, and `\s+` absorbs any CRLF introduced in transit.

### M-2. Steps 2 and 3 are separate calls, so they are not atomic.
The migration commits itself, so the `schema_migrations` insert is a second call. If Step 3 fails, the objects exist on prod without their version row, and a push would hard-fail `db-migrations-applied.yml`.
- Step 3 is idempotent (`on conflict (version) do nothing`).
- Before the push, confirm it with `select version, name from supabase_migrations.schema_migrations where version = '20261025000000';`. Expect exactly one row, `cross_store_item_rejection`.
- Keep it as two calls. Folding the insert into the file would break "verbatim".

### M-3. Commit hygiene with spec 176 staged.
The working tree has spec 176 staged (including `src/**`) and spec 177 untracked or unstaged. AC-22's fence is met: 177 touches only its migration, three test files and the spec. Two things to watch:
- Stage 177's paths explicitly (no `git add -A` sweep) so the two specs' commits stay separable.
- Whichever push first carries `20261025000000` must come **after** Steps 2-4 succeed on prod. That applies even if 176 and 177 go out in the same push.

### M-4. The report_last_order_context wrapper bypasses the trigger for the whole multi-row fixture INSERT.
The bypass covers the well-formed rows as well as the malformed G1/G2 row. That is acceptable: the file pins read-side behaviour, and the new trigger's write-side coverage lives in `cross_store_item_rejection.test.sql`. The comment correctly says "this one fixture INSERT". Informational only. If a later spec needs to split the fixture, the rows other than G1/G2 would need real `test.store_a` items.

---

## Runbook readiness summary for main Claude

Once the owner approves, the §10 runbook can be executed verbatim **with S-1 and S-2 applied**:

| Step | Action |
|---|---|
| 1 | Read-only pre-check as written. Expect: PG 17.x; exactly `20261024000000` at or above the cutoff; 3 × NULL `to_regprocedure`; 0 bad `po_items` counts; 0 `order_approvals`; FK `confdeltype` `a` on `po_items.item_id`; the listed existing triggers. |
| 2 | **(S-1)** `execute_sql` of the full committed file text. |
| 3 | Version insert as written, then the M-2 confirm select. |
| 4 | md5 and privilege/trigger presence as written. Compare against fresh local values (M-1). |
| 5 | **(S-2)** The raise-always DO probe. Expect `PROBE OK: …`. |
| 6 | Push, then confirm `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand. |

Rollback stays as written: drop the three triggers, then the three functions. It is pure DDL, and no client is coupled to it.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 6 findings by severity: 0 Critical, 2 Should-fix (both in the architect's own §10 prod runbook: Step 2 must execute the committed file verbatim, not a pg_get_functiondef dump; Step 5 probe replaced with a self-contained raise-always DO block), 4 Minor. The developer's CASE-guard deviation is accepted.
payload_paths:
  - specs/177-cross-store-item-rejection/reviews/backend-architect.md
