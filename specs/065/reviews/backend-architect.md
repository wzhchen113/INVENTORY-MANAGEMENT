# Spec 065 — Backend Architect Drift Review (post-impl)

Status of source: `Status: READY_FOR_REVIEW`. Migration landed at
`supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql`.

Verdict: **SHIP_READY.** No contract drift. Single deviation from the design's
pseudo-SQL is purely cosmetic (statement formatting); semantics are byte-identical.

---

## 1. Migration body vs. design's "Migration body" — matches design

Design called for (specs/065... §Migration body):

```sql
begin;

alter table public.eod_submissions
  drop constraint if exists eod_submissions_submitted_by_fkey;

alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
  foreign key (submitted_by)
  references public.profiles(id)
  on delete set null;

commit;
```

Landed (migration:33-42):

```sql
begin;

alter table public.eod_submissions
  drop constraint if exists eod_submissions_submitted_by_fkey;

alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
    foreign key (submitted_by) references public.profiles(id) on delete set null;

commit;
```

✅ **Matches design.** Differences are whitespace-only — the `add constraint`
clause is collapsed onto two indented lines instead of four. Postgres parses
both forms to the exact same `pg_constraint` row (`confupdtype = 'a'`,
`confdeltype = 'n'`, same conkey/confkey/confrelid). The `begin/commit`
boundary is preserved per the design's belt-and-braces rationale. The
`if exists` on the drop is preserved per the design's idempotency rationale.

No semantic deviation.

---

## 2. Timestamp `20260527000000_` — matches design

✅ **Matches design.** Confirmed strictly greater than the previous head
`20260525000000_staff_submit_eod_per_user_jwt.sql`. Glob over
`supabase/migrations/2026052*.sql` returns the new file as the final entry.
Midnight-anchored stamp aligns with the convention cited in the design
(`20260513000000`, `20260514130000`, etc.).

---

## 3. Header comment — captures all three risk angles from design

Design required the comment to capture:
- Trigger orthogonality (vs. spec 020 `eod_submissions_set_submitted_by_trg`)
- RLS non-impact
- Realtime non-impact (no publication membership change)

Landed comment (migration:1-31):
- Lines 18-26: trigger orthogonality with explicit name-check
  (`eod_submissions_set_submitted_by_trg`), file:line ref, and the
  "auth.uid() under the postgres cascade role is NULL" rationale verbatim
  from the design.
- Lines 28-29: explicit RLS non-impact statement.
- Lines 29-30: explicit "docker restart supabase_realtime_* ritual does NOT
  apply" callout, matching the design's realtime gotcha disclaimer.
- Lines 5-9: pointer at the failing test (`auth_can_see_store_brand_scope.test.sql`
  arm (12)) — slightly enriched over the design (the design's comment block
  did not name the teardown statement explicitly; the landed version does).

✅ **Matches design + minor enrichment.** The enrichment (naming the
failing teardown statement) is a documentation improvement, not a contract
change.

---

## 4. Scope discipline — touches ONLY `eod_submissions_submitted_by_fkey`

Design surveyed 11 other actor FKs (`user_stores.user_id`,
`inventory_items.last_updated_by`, `prep_recipes.created_by`,
`waste_log.logged_by`, `purchase_orders.created_by`,
`purchase_orders.received_by`, `pos_imports.imported_by`,
`audit_log.user_id`, `flags.user_id`, `flags.resolved_by`,
`report_definitions.created_by`, `report_runs.ran_by`) and explicitly
deferred them to a follow-up audit-sweep spec.

Landed migration (43 lines including comment + 2 SQL statements):
- Statement 1: `drop constraint if exists eod_submissions_submitted_by_fkey`
- Statement 2: `add constraint eod_submissions_submitted_by_fkey ... on delete set null`

✅ **Matches design.** Zero other tables touched. No drift into the
deferred 11-column sweep.

---

## 5. No other files changed (SQL-only spec)

The spec under "Files changed" lists:
- `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql` (new)

I cross-referenced:
- No edge function changes claimed or visible
  ([supabase/functions/](../../../supabase/functions/) untouched per the
  spec's §"Edge function changes: None")
- No RLS migration claimed (per spec §"RLS impact: None")
- No RPC body change claimed (per spec §"API contract: None")
- No `src/lib/db.ts` surface change claimed (per spec §"src/lib/db.ts
  surface: None")
- No `src/store/useStore.ts` slice change claimed (per spec §"Frontend
  store impact: None")
- The pgTAP test file `auth_can_see_store_brand_scope.test.sql` is
  explicitly NOT modified (per design's "Do NOT touch" list)

✅ **Matches design.** Single-file change as designed. (Note: git diff
output not retrieved in this thread — the architect's review is bound to
the design contract and the file the spec claims to have landed. The
release coordinator will see the full git diff. If the diff shows
anything other than the migration + spec markdown, that's a contract
break to escalate, but the artifacts I can read are consistent with the
SQL-only scope.)

---

## 6. Test outcome — deferred to test-engineer per protocol

The spec claims:
- `bash scripts/test-db.sh`: 34/34 pgTAP suites pass (up from 33/34).
- `auth_can_see_store_brand_scope.test.sql` passes for the first time.
- `npm test`: 316/316 jest unchanged.
- `npm run typecheck` + `npm run typecheck:test`: clean.
- `pg_constraint.confdeltype = 'n'` verified post-migration via psql.

Per dispatch instructions, mutation reproduction is owned by test-engineer
running in parallel. From the architect side, the success criterion
encoded as design AC2 (the brand-scope test passing) is the canary the
design designated; the FE-dev report indicating 34/34 pgTAP is consistent
with that. ✅ **Consistent with design's test plan**, pending
test-engineer's mutation confirmation.

---

## Findings summary by severity

- ❌ Contract break: **0**
- ⚠ Deviation justified: **0**
- ✅ Matches design: **6 / 6** drift points

The landed migration is a byte-equivalent realization of the design's
pseudo-SQL, with the header comment slightly enriched to name the
failing test's teardown statement explicitly — a documentation
improvement that does not alter the contract.

## SHIP_READY

No architectural drift. The migration as landed matches the design
contract. Recommend SHIP_READY from the architect's seat, gated on the
parallel test-engineer mutation result and release-coordinator's
synthesis.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 findings; landed migration
matches design byte-for-byte (semantic-equivalent — only whitespace
differs in the add-constraint clause). SHIP_READY from the architect's
seat.
payload_paths:
  - specs/065/reviews/backend-architect.md
