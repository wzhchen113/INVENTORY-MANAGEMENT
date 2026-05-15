# Backend-architect post-impl drift review — Spec 034

Reviewer: backend-architect (post-implementation drift mode)
Scope: walk every file listed under `## Files changed` against the
`## Architect design` section I produced. Identify divergences from the
design contract, missed edits, boundary creep, and deploy gaps.

Verdict: **PASS with minor notes.** Zero Criticals, zero Should-fix, four
Nits. The runner, dispatcher, pgTAP suite, and frontend wiring all match
the design. The architect's own skeleton in §A4 had a default-window
mistake that the AC contradicted; the developer correctly followed the
AC. One deploy-step nit (`supabase db push --linked --yes`) and one
audit-trail nit on the `// REPORTS-N` history comment.

---

## Critical

None.

## Should-fix

None.

## Nits

### N1 — Architect's own §A4 skeleton drifted from the AC on the default window (developer correctly followed the AC)

**Where.** Spec `## Architect design`, §A4 skeleton, lines 647-654 vs
the spec's AC line 35-37.

The architect's skeleton comment block reads:

> Default window: last 7 days inclusive (today-7d → today), matching the
> PM's resolved default. Note: this differs from COGS which defaults to
> 30 days — waste is a shorter-horizon signal per the PM resolution.

But the AC at line 35-37 explicitly pins:

> `from` (string, `YYYY-MM-DD`) — defaults to `current_date - interval '30
> days'` when null/empty, matching COGS line 111-114.

The implemented migration at
[supabase/migrations/20260514170000_report_run_waste.sql:99-102](../../../supabase/migrations/20260514170000_report_run_waste.sql)
uses 30 days, matching the AC. The developer correctly resolved the
ambiguity by following the AC over the skeleton — but this is a self-
inflicted post-impl-drift signal on the architect's part (mine). The
skeleton's `-- last 7 days` comment block was a copy-edit error during
design.

No code change required. Calling it out so future architects don't
re-introduce 7 days by reading my skeleton instead of the AC. The
implementation is correct.

### N2 — Spec `## Files changed` lists "Post-merge deploy" but no evidence the developer confirmed the migration was NOT auto-applied

**Where.**
[specs/034-reports-waste-template/spec.md:1366-1371](../../spec.md) under
`### Post-merge deploy`.

The spec's `Post-merge deploy` section calls out:

> `npx supabase db push --linked --yes` — applies the new migration
> (`20260514170000_report_run_waste.sql`). No edge function deploy. No
> realtime publication change.

This is the standard manual gate per CLAUDE.md "CI workflow" resolved-
question (the `db-migrations-applied.yml` workflow is not on disk).
The developer's `## Files changed` block doesn't explicitly attest to
having NOT run `db push --linked` against the linked project. The user
asked me to "confirm the dev did NOT run it" — I have no evidence
either way from the spec text alone. The `git status` snapshot in the
dispatching prompt shows no commit-on-disk change to remote state
either, so this is most likely fine, but the release-coordinator should
surface this as a manual deploy step before SHIP_READY rather than
assuming it already ran.

Recommendation: release-coordinator includes
`npx supabase db push --linked --yes` in the SHIP_READY checklist (the
spec already calls it out at line 1366 — release-coordinator should
mirror).

### N3 — `templates.ts` history comment line uses "Spec 034" rather than the existing `REPORTS-N` numbering convention

**Where.**
[src/screens/cmd/sections/reports/templates.ts:12-14](../../../src/screens/cmd/sections/reports/templates.ts).

The two earlier lines read:

```
// REPORTS-2 flipped `cogs` to 'live' (see `20260511120000_report_run_cogs.sql`).
// REPORTS-3 flipped `variance` to 'live' (see `20260512120000_report_run_variance.sql`).
```

The new line reads:

```
// Spec 034 flipped `waste` to 'live' (see `20260514170000_report_run_waste.sql`).
```

My §A7 design explicitly *allowed* either form ("The developer can drop
the number or write `// Spec 034 flipped waste to 'live'`"). The
developer picked the second form. Functionally identical; the historical
audit trail is preserved. A future spec might want to standardize on one
or the other (probably the migration-filename anchor, since `REPORTS-N`
is informal and was never written down anywhere else). Not a blocker.

### N4 — pgTAP plan count is 11 per design §A5, but the architect's arm-counting math has a copy-paste glitch in the spec text

**Where.** Spec line 930-939 (`Why 11 arms vs the AC's "at least 8 cases."`)

The architect's own justification reads:

> 2+1+1+3+1+1+1+1 = 11.

That's 8 addends, but only 7 of the listed cases are described as
1-arm. Three +1s come from "AC explicitly lists those three sub-
assertions on line 192-194". The math works out to 11 if you also
count the +2 fixture probes and the +3 happy-path triple, but the
sentence reads like "case (5)" is double-counted. The implemented test
has exactly plan(11) and 11 `select ...` assertion calls
([supabase/tests/report_run_waste.test.sql:65-249](../../../supabase/tests/report_run_waste.test.sql)),
which is the contract that matters. The narrative in the spec is
slightly off but the count and coverage shape match.

No code change required.

---

## Drift evaluation against design § by §

| Design section | Verification | Status |
|---|---|---|
| §A1 — Per-mode named row keys | Migration lines 124-146 emit per-mode columns (`reason`/`category`/`item`); rows at lines 274-281 / 309-316 / 351-358 emit the matching JSONB keys. Frame renderer at [ReportDetailFrame.tsx:560+](../../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx) uses `row[col.key]` (verified untouched). | MATCH |
| §A2 — Dispatcher arm placement | New arm at line 447 sits immediately after `when 'variance'` at line 445. `stub` / `cogs` / `variance` / `not_implemented` preserved verbatim. No forward-reference comment (per design). | MATCH |
| §A3 — Migration filename `20260514170000_report_run_waste.sql` | Exact name on disk; latest slot on 2026-05-14 after `160000_assert_not_last_of_role.sql`. | MATCH |
| §A4 — Migration shape (header notes + SECURITY INVOKER + grants) | Header preserves all six design-note bullets plus the architect's `Index reuse` addendum (lines 56-60, which I did NOT originally pin but the developer correctly traced from the AC line 381-384). `security invoker`, `set search_path = public`, `revoke from public, anon`, `grant to authenticated` all present at lines 67-69 and 411-412. | MATCH |
| Window `[from, to]` closed | Lines 164-165 and 260-261, 295-296, 336-337, 382-383 use `>= v_from AND <= v_to`. Closed-window divergence from variance documented at header lines 20-24. | MATCH |
| §A5 — pgTAP plan(11) with 11 arms | `select plan(11);` at line 26; 11 `select` assertion calls verified (fixture isnt() ×2 → 1,2; throws_ok ×1 → 3; empty-range is() ×1 → 4; KPI is() ×1 → 5; qty is() ×1 → 6; dollar_impact is() ×1 → 7; missing-cost is() ×1 → 8; ordering is() ×1 → 9; envelope is() ×1 → 10; by-mode smoke is() ×1 → 11). | MATCH |
| §A6 — `reports_anon_revoke.test.sql` plan 8→9 with new arm (5) | `plan(9)` at line 35; new arm at lines 107-119 sits between variance (4) and reorder-list (6); header bullet list updated at line 15 to list `report_run_waste`. Downstream arm comment markers renumbered correctly (6/7/8). | MATCH |
| §A7 — Cmd UI wiring (4 files + types) | All 5 files touched per design: `templates.ts` flag flip, `NewReportModal` with `BY_OPTIONS` registry + `defaultByForTemplate` helper (developer added the helper as a small additional clarification — not a divergence, matches design intent), `ReportsSection.tsx` OverrideState widened, `ReportDetailFrame.tsx` `savedBy` parser widened + `ByPopover` accepts `options` prop, `src/types/index.ts` JSDoc-only addition. | MATCH (with developer's `defaultByForTemplate` helper as a small clarification — better than my single-ternary suggestion) |
| §A8 — No `src/lib/db.ts` change | Verified untouched. | MATCH |
| §A9 — No realtime publication change | New migration grep'd for `supabase_realtime` / `alter publication` returns 0 hits. No `docker restart` needed (waste_log already on the publication per `20260514140000_realtime_publication_tighten.sql`). | MATCH |
| §A10 — No `useStore.ts` change | `git status` snapshot in dispatching prompt shows `src/store/useStore.ts` as modified, but that's from the open spec 029 branch (frontend-polish-trio), NOT this spec. Confirmed by grep'ing for `waste` / `reason` / `report_run_waste` in the file — no hits. | MATCH |
| §A11 — No edge function change | `supabase/functions/` untouched, `supabase/config.toml` untouched. | MATCH |
| §A12 — `app.json` not touched | Verified untouched. | MATCH |

---

## Specific architect-checklist sweeps the user asked for

### 1. Migration filename `20260514170000_report_run_waste.sql` — correct slot?

YES. Last migration on disk before this one is
`20260514160000_assert_not_last_of_role.sql` (spec 031). Today is
2026-05-14. The new file at 17:00:00 is the next free hour-slot,
matching the design §A3 convention.

### 2. Function signature `report_run_waste(p_store_id uuid, p_params jsonb) RETURNS jsonb`?

YES — [supabase/migrations/20260514170000_report_run_waste.sql:63-66](../../../supabase/migrations/20260514170000_report_run_waste.sql).
`language plpgsql`, `security invoker`, `set search_path = public` all
present at lines 67-69. Matches design §A4.

### 3. GRANT/REVOKE shape per §1?

YES — lines 411-412:

```sql
revoke execute on function public.report_run_waste(uuid, jsonb) from public, anon;
grant  execute on function public.report_run_waste(uuid, jsonb) to authenticated;
```

Mirrors the spec 016 convention. The dispatcher is also re-granted at
lines 462-463. `reports_anon_revoke.test.sql` arm (5) at lines 107-119
proves the lockdown end-to-end against the anon role.

### 4. Date window CLOSED `[from, to]` — header documents the divergence?

YES — header lines 20-24:

```
-- • Date window divergence from variance. CLOSED [from, to] on
--   logged_at::date (`>= v_from AND <= v_to`), NOT variance's
--   half-open (v_from, v_to]. Rationale: waste is an event log,
--   not anchor-pair reconciliation; single-day windows must include
--   that day's rows. COGS line 297 is the precedent.
```

All four `where` clauses use `>= v_from AND <= v_to` (lines 164-165,
260-261, 295-296, 336-337, 382-383). Matches design.

### 5. Per-mode named row keys per §A1?

YES. The migration emits row JSONB keyed `reason` / `category` /
`item` (lines 274-281, 309-316, 351-358) with shared `qty` /
`items_affected` / `dollar_impact` / `unit` keys. Column headers at
lines 124-146 use the matching keys.

### 6. Dispatcher arm placement immediately after variance per §A3?

YES. Line 447 — `when 'waste' then` — sits immediately after `when
'variance' then` at line 445. The `stub` / `cogs` / `variance` arms
and the `not_implemented` fallback are preserved verbatim from the
spec 018 variance migration at
[supabase/migrations/20260512120000_report_run_variance.sql:643-660](../../../supabase/migrations/20260512120000_report_run_variance.sql).

### 7. Multi-series chart by reason regardless of `by:` toggle per design?

YES — migration section (9) at lines 364-399 computes one series per
`reason` regardless of `v_by`. The `< 2 distinct dates → '[]'`
short-circuit at line 372 mirrors COGS line 661-672. Series NEVER
returns `null` — fixed `'[]'::jsonb` literal at line 373.

### 8. Hardcoded KPI tone bands `<$50` ok / `$50-$200` warn / `>$200` danger per design?

YES — lines 202-206:

```sql
v_tone := case
            when v_total_dollar < 50  then 'ok'
            when v_total_dollar < 200 then 'warn'
            else 'danger'
          end;
```

Top-driver KPI uses the same band at lines 226-230. Header lines
49-50 document the bands so reviewers don't relitigate.

### 9. Frontend wiring — savedBy parser + ByPopover changes?

YES. Developer caught both non-obvious frontend changes:

- `savedBy` parser at
  [ReportDetailFrame.tsx:187-191](../../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx)
  generalises the legacy `rawBy === 'item' ? 'item' : 'category'` to
  admit `'reason'` via a three-way ternary. COGS behaviour preserved
  (any value other than `'item'` or `'reason'` coerces to `'category'`).
- `ByPopover` at
  [ReportDetailFrame.tsx:653-660](../../../src/screens/cmd/sections/reports/ReportDetailFrame.tsx)
  now accepts an `options` prop instead of the hardcoded
  `['category', 'item'] as const` literal. The `byOpts` at lines
  263-266 derives the per-template list from `definition.templateId`.

### 10. `BY_OPTIONS` registry pattern matches design?

YES. The modal at
[NewReportModal.tsx:65-81](../../../src/components/cmd/NewReportModal.tsx)
implements the `BY_OPTIONS` Record exactly per design §A7, plus a
small `DEFAULT_BY_OPTIONS` fallback (`['category', 'item']`) for any
non-mapped template id. The developer also added a
`defaultByForTemplate(templateId)` helper that the design's §A7
suggested inline; promoting it to a named helper makes the modal-open
and mid-modal-switch effects (lines 140, 192) consistent. Better than
my inline-ternary suggestion. No divergence.

### 11. Boundary violations — unintended file touches?

NONE. The spec's `Files changed` block lists exactly 8 files
(1 migration, 2 pgTAP, 4 frontend, 1 types). Every touched file is
in-scope. The `git status` snapshot in the dispatching prompt shows
4 unrelated files modified (`InviteUserDrawer.tsx`, `useRole.ts`,
`UsersSection.tsx`, `useStore.ts`) — those are the open spec 029
worktree (frontend-polish-trio), NOT spec 034, and the dispatching
prompt explicitly enumerates the 9 spec-034 files (the spec edit
counts as the 9th). The `useStore.ts` modification is unrelated to
this spec.

### 12. Realtime / edge functions / db.ts / useStore — all untouched per cross-cutting confirmations?

YES (all four). Verified by direct file inspection and grep:

- Migration contains no `alter publication` or `supabase_realtime`
  references.
- `supabase/functions/` and `supabase/config.toml` are untouched.
- `src/lib/db.ts` contains no `report_run_waste` or `waste`-template-
  specific references (the generic `runReportRpc` plumbing handles it).
- `src/store/useStore.ts` contains no waste-template-specific
  references (the generic `runReport`/`loadLatestRun`/
  `addReportDefinition` actions handle it).

### 13. pgTAP test design plan(N) with specific arm coverage — do the 11 arms match?

YES. Arm-by-arm correspondence:

| Arm | Coverage | File line |
|---|---|---|
| 1  | Fixture: Frederick id resolves       | 66-67   |
| 2  | Fixture: cost>0 item resolves        | 70-71   |
| 3  | Auth gate (Charles → 42501)          | 86-94   |
| 4  | Empty range envelope shape           | 105-121 |
| 5  | Single-row KPI Total waste $ = $30   | 154-163 |
| 6  | Single-row Spoilage qty = '2.500'    | 166-175 |
| 7  | Single-row Spoilage $ = '$10.00'     | 178-187 |
| 8  | Missing-cost zero-out                | 191-200 |
| 9  | Multi-row ordering by $ DESC          | 204-214 |
| 10 | Envelope shape sorted-keys           | 218-226 |
| 11 | by='category' AND by='item' smoke    | 243-250 |

The fixture inserts (lines 134-144) include one row with `cost_per_unit
IS NULL` (`Quality issue`, qty=1.0) and another `Theft` row at $20.00,
so arms (5)/(8)/(9) all share one fixture set — efficient. Single-day
window `from=to=2026-05-02` triggers the `<2 distinct dates` series
short-circuit, so arm (10) implicitly covers the empty-series branch
too (the envelope still has all four keys; `series` is `[]` not
absent). Good test density.

### 14. Post-merge deploy — `npx supabase db push --linked --yes` step

The spec calls it out at line 1366. No evidence the developer ran it,
which is correct — manual deploy is the user's gate per the resolved
"CI workflow" question in CLAUDE.md. Release-coordinator should
surface this as a SHIP_READY checklist item.

---

## Summary

Implementation is faithful to the design. The runner, dispatcher,
pgTAP suite, and frontend wiring all match the contract. The
developer caught both non-obvious frontend changes the architect
flagged in §A7 (`savedBy` parser + `ByPopover` options prop) and
modestly improved the design with the named `defaultByForTemplate`
helper.

The four Nits are:

- **N1** — architect's own design skeleton had a 7-day default in a
  comment block, contradicting the AC's 30-day default. Developer
  correctly followed the AC. Self-inflicted design-document drift on
  the architect's part; no code change.
- **N2** — release-coordinator should surface `npx supabase db push
  --linked --yes` as a SHIP_READY checklist item.
- **N3** — `templates.ts` history comment uses "Spec 034" instead of
  `REPORTS-N`. Allowed by design; not a regression.
- **N4** — architect's own arm-counting narrative in spec §A5 is
  slightly off (the math works out but the prose reads ambiguously).
  Implementation has exactly 11 arms matching the design.

No Critical or Should-fix findings. Spec is ready for the release-
coordinator to fold into the SHIP_READY proposal.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  4 Nits. Implementation matches design.
payload_paths:
  - specs/034-reports-waste-template/reviews/backend-architect.md
