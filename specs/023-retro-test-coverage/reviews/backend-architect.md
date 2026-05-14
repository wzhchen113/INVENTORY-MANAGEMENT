# Spec 023 — Backend architectural drift review (post-impl)

Scope: verify the dev's implementation against the architect's `## Backend
Architecture` section. Read-only. Findings ranked Critical / Should-fix /
Minor.

## Drift inventory

| Item                                              | Verdict        |
|---------------------------------------------------|----------------|
| A1 dispatcher unknown template (plan(4))          | Faithful       |
| A2 variance formula (plan(7))                     | Approved Drift |
| A3 cross-store entries (plan(3))                  | Faithful       |
| A4 EOD consistency, three arms (plan(6))          | Faithful       |
| A5 MIN-DOW + cutoff (plan(5))                     | Faithful       |
| A6 anon revoke (plan(8))                          | Faithful       |
| A7 multi-vendor SUM (plan(4))                     | Faithful       |
| A8 inventory_counts append-only (plan(5))         | Faithful       |
| A9 EOD edit flow (plan(4))                        | Approved Drift |
| A10 hybrid max() (plan(5))                        | Faithful       |
| A11 EOD-first sourcing (plan(3))                  | Faithful       |
| B1 jest-native swap                               | Faithful       |
| B2 README workflow ref                            | Faithful       |
| B4 seedVarianceDates extraction + test            | Faithful       |
| B5 transitive-store-import docs                   | Faithful       |

Block recommendation: **No.** The two Approved Drifts (A9 mechanism swap,
A2 explicit `po_number`) are both well-documented in the dev's notes and
preserve the assertion semantics the spec set out to lock down. No
Critical findings.

## Honored caveats (architect's three)

### Caveat 1 — A4 third arm reframe

**Verdict: Faithful.**

`supabase/tests/eod_submissions_consistency.test.sql:148-181` reframes
the third arm exactly as the architect prescribed:

- The migration `20260514120030_eod_submissions_consistency.sql` only
  declares two trigger arms (submitted_by override on `eod_submissions`,
  cross-store item_id on `eod_entries` lines 104-138). No vendor_id
  consistency trigger exists; `eod_entries` does not even have a
  `vendor_id` column.
- The test inserts a same-store entry (Frederick parent submission +
  Frederick item) and asserts it succeeds (`is(count, 1)`), then asserts
  the cross-store INSERT from arm (ii) did not silently leak through.
- The header comment at lines 14-22 explicitly cites the architect's
  caveat #1 and pins the assertion as "trigger is permissive on the
  columns it does not check" — future-proofing against a too-strict
  trigger landing later.

The dev's plan count of 6 matches the architect's §1 prescription: 1
fixture sanity + arm(i) + arm(i defense isnt) + arm(ii) throws_ok +
arm(iii) same-store success + arm(iii) final count.

### Caveat 2 — A8 inventory_counts is fully append-only

**Verdict: Faithful.**

`supabase/tests/inventory_counts_append_only.test.sql:25-167` asserts
all 4 matrix cells return 0 rows:

- Manager UPDATE → 0 (line 96-100).
- Manager DELETE → 0 (line 113-117).
- Admin UPDATE → 0 (line 145-149).
- Admin DELETE → 0 (line 162-166).

The dev correctly rejected the PM-prompt's mistaken "admin can UPDATE
→ 1 affected" line and asserted the spec-019 reality: `inventory_counts`
has no UPDATE policy and no DELETE policy at all (migration
`20260513120000_inventory_counts_consistency.sql:115-131`). The header
comment at lines 12-19 explicitly cites the architect's caveat #2 and
distinguishes this from `eod_submissions` semantics.

Plan count of 5 (1 fixture sanity + 4 matrix cells) is one higher than
the architect's literal §1 prescription of 4. This is a Faithful match
on the spec's text: the architect's §1 listing said "plan(N): 4 (fixture
sanity + UPDATE 0-rows under manager + DELETE 0-rows under manager +
UPDATE 1-row under admin, DELETE still 0)" — but the architect's own
text under "Architect decision" then said the test should be "manager
UPDATE → 0, manager DELETE → 0, admin UPDATE → 0, admin DELETE → 0",
which is 5 assertions when fixture sanity is included. Dev's plan(5)
faithfully matches the architect's resolved decision, not the internally
inconsistent count in the §1 plan line.

### Caveat 3 — A5 wall-clock flake mitigation

**Verdict: Faithful.**

`supabase/tests/report_reorder_list_min_dow.test.sql:227-269` uses
`order_cutoff_time = '23:59:59'` for Scenario C exactly as the
architect's caveat #3 documented, minimizing the flake window to the
last 1 second of the UTC day. Header comment at lines 24-30 cites the
caveat explicitly and notes the trade-off accepted.

Note the architect's literal text said `'23:59:59.999'` (last
millisecond); dev landed `'23:59:59'` (last second). The widened flake
window is still effectively zero risk on a CI runner whose wall-clock
window crosses a single-second-of-day-end is statistically negligible.
Documented inline; acceptable.

## Dev deviations

### Deviation 1 — A9 fourth assertion: UPDATE instead of delete+reinsert

**Verdict: Approved Drift.**

The architect's literal §1 prescription for A9 said "delete the prior
entry row and INSERT a new one with a new `actual_remaining` value".
Dev landed an UPDATE instead, citing that `eod_entries` has no DELETE
policy.

Verified against the migration. `20260514120030_eod_submissions_consistency.sql:189-200`
**drops** the `store_member_delete_eod_entries` policy and does not
replace it with any DELETE policy under any role. The corresponding
admin-only UPDATE policy IS preserved at lines 161-181
(`admin_update_eod_entries`). The architect's prescribed delete-then-
reinsert path would have returned 0 rows on the DELETE under PostgREST
+ admin JWT (RLS-filtered silently), so the test would either be
inert or the dev would need to switch to a different runner (service-
role JWT). The UPDATE-of-`actual_remaining` approach exercises the
preserved admin policy on the live policy graph, which is the
architectural truth.

Plan count and semantics preserved: 4 assertions (1 fixture sanity +
id stable + submitted_at bumped + actual_remaining updated). The
end-state assertion is the same — `actual_remaining = 7`. Dev's note
at the file header (line 18-19) and inline (line 161-169) call out the
mechanism difference explicitly. Approved.

The architect should also note: had the architect's literal prescription
been followed, the test would have been a quiet false-positive (DELETE
silently fails RLS, INSERT succeeds, the "delete worked" assumption is
unchecked). The dev's deviation actually closes a latent design hole in
the architect's recipe.

### Deviation 2 — A2/A10 explicit `po_number`

**Verdict: Approved Drift, with one minor flag for spec 024.**

Only A2 actually uses the explicit `po_number` workaround
(`supabase/tests/report_run_variance_formula.test.sql:141-157`). A10
does NOT insert any `purchase_orders` rows — verified by grep across
`supabase/tests`. The dev's Files-changed bullet that says "A2 / A10"
is slightly inaccurate; the workaround is in A2 only. Minor docs nit
in the spec's `## Files changed` section.

The mechanism is sound. The `generate_po_number()` BEFORE-INSERT
trigger (`20260405000759_init_schema.sql:221-238`) only fires when
`new.po_number is null`, so setting an explicit value side-steps the
trigger entirely. The dev's claim that the trigger's
`cast(substring(po_number from 4) as int)` errors on pre-existing
legacy dev data is plausible — the local container can accumulate
hand-written rows during dev that don't match `PO-NNN`, and `seed.sql`
does not contain `po_number` data, so the trigger's max-scan would not
find such drift in a fresh `dev:db:reset`. The workaround is
defensive against local dev-state drift and does not mask a
prod-relevant bug.

**Minor finding for spec 024 (or a separate hardening spec):** the
`generate_po_number()` trigger has an unsafe substring-cast that
could fail in prod if a `po_number` row ever lands that doesn't match
`PO-N+`. Worth surfacing as a separate hardening task — out of scope
for spec 023. The dev's inline comment at A2 lines 141-146 is the
cleanest place we have a record of this latent bug.

## Other drift checks

### File naming

All 11 expected `.test.sql` files are present under `supabase/tests/`
with the architect-prescribed names:

```
supabase/tests/report_run_unknown_template.test.sql           ✓ A1
supabase/tests/report_run_variance_formula.test.sql           ✓ A2
supabase/tests/inventory_count_entries_check_store.test.sql   ✓ A3
supabase/tests/eod_submissions_consistency.test.sql           ✓ A4
supabase/tests/report_reorder_list_min_dow.test.sql           ✓ A5
supabase/tests/reports_anon_revoke.test.sql                   ✓ A6
supabase/tests/report_run_variance_multivendor_sum.test.sql   ✓ A7
supabase/tests/inventory_counts_append_only.test.sql          ✓ A8
supabase/tests/eod_submissions_edit_flow.test.sql             ✓ A9
supabase/tests/report_reorder_list_hybrid_formula.test.sql    ✓ A10
supabase/tests/report_reorder_list_on_hand_source.test.sql    ✓ A11
```

Faithful.

### Plan counts

| Spec line | Architect §1     | Implementation | Verdict       |
|-----------|------------------|----------------|---------------|
| A1        | 4                | 4              | Faithful      |
| A2        | 7                | 7              | Faithful      |
| A3        | 3                | 3              | Faithful      |
| A4        | 6                | 6              | Faithful      |
| A5        | 5                | 5              | Faithful      |
| A6        | 7                | 8              | Faithful (*)  |
| A7        | 4                | 4              | Faithful      |
| A8        | 4 (incons.)      | 5              | Faithful (**) |
| A9        | 4                | 4              | Faithful      |
| A10       | 5                | 5              | Faithful      |
| A11       | 3                | 3              | Faithful      |

(*) A6: architect §1 said "plan(N): 7 (one fixture sanity, six anon-call
denials, one per RPC)" but then enumerated **seven** RPCs (the §1 text
explicitly added `staff_submit_eod` as a seventh). 1 + 7 = 8. Dev's
plan(8) matches the architect's enumerated RPC list, not the
internally inconsistent "six" in the §1 prose. Faithful to the resolved
intent.

(**) A8: architect §1's plan(4) line listed four cells; the architect's
"Architect decision" paragraph later in §1 listed all four matrix cells
(manager UPDATE, manager DELETE, admin UPDATE, admin DELETE) + fixture
sanity = 5. Dev's plan(5) faithfully matches the resolved intent.

### Track B contracts

**B1 — `@testing-library/jest-native` swap.** Faithful.
- `package.json` no longer contains `jest-native` (grep clean).
- `jest.config.js:79-83` replaces the `'@testing-library/jest-native/
  extend-expect'` entry with a comment explaining the removal — the
  component project's `setupFilesAfterEnv` no longer has the import.
- Both shipped test files (`StatusPill.test.tsx`, `relativeTime.test.ts`)
  use only `toBeTruthy()`, `toBeNull()`, `toBe(...)` — no
  jest-native-specific matchers, so no green-test regression risk.

**B2 — README workflow reference.** Faithful.
- `grep -n 'db-migrations-applied' README.md` returns no matches.
- The two architect-cited spots:
  - Line 137 (structure summary): now shows `test.yml`.
  - Line 224 (CI section): now points at `test.yml`.
- Architect's design said "replace with a one-line reference to
  `test.yml`"; dev replaced both spots accordingly. Note the dev's
  Files-changed bullet says "replaced the stale 'CI deploy-gate' section
  with a pointer to `test.yml`" — the section header `## CI` survives,
  the body now points at `tests/README.md` for the breakdown.
- Minor: `README.md:263` still mentions "CI deploy-gate workflow" as a
  "Recent changes" bullet (no filename reference). Architect's spec
  only cited lines 137 + 224; line 263 is out of the B2 contract and
  remains as a stale content claim. Flag as Minor for a future
  README-cleanup pass.

**B4 — seedVarianceDates extraction + test.** Faithful.
- `src/utils/seedVarianceDates.ts` exports the verbatim signature
  `(storeId: string) => Promise<{ from: string; to: string; eodCount:
  number }>` (line 23-25). Behaviour contract preserved verbatim
  from the inlined original.
- `src/utils/seedVarianceDates.test.ts` declares the module-level mock
  with `jest.mock('../lib/db', () => ({ fetchRecentEodDates:
  jest.fn() }))` (line 28-30) — exactly the canonical boundary-mock
  shape from `tests/README.md:54-79`.
- Three assertions present: happy path (line 42-51) → returns
  `{ from: '2026-05-01', to: '2026-05-02', eodCount: 2 }`; one-EOD
  path (line 53-61) → blank from/to + eodCount: 1; error path
  (line 63-71) → blank from/to + eodCount: 0.
- `NewReportModal.tsx:12-13` updated to import from new location;
  call sites at lines 123 + 150 untouched (function name preserved).
- Header comment at the test file (lines 11-17) documents the
  `jest.mock` hoisting pitfall the architect flagged in §5.

**B5 — Transitive store-import gotcha docs.** Faithful.
- `tests/README.md:90-108` adds the "Decision tree — first thing to
  try when adding a component test" preamble with three patterns in
  priority order: (1) extract → cite seedVarianceDates.test.ts,
  (2) mock theme hook → cite StatusPill.test.tsx, (3) provider-wrap →
  future-only.
- `tests/README.md:396-406` collapses the original "First follow-up
  coverage targets" table into a "Retroactive coverage status (spec
  023)" subsection per the architect's recommendation (architect §2 /
  B5: "Recommend the shorter 'collapse' approach"). The replacement
  text references all 11 retroactive tests under `supabase/tests/`.

## Forward-compat for spec 024 — TypeScript persistence

The dev's note in `## Files changed` says: "Verified that `npx tsc
--noEmit -p tsconfig.test.json` produces only the pre-existing
`useStore.ts` / `webPush.ts` errors; no new TS errors introduced by
023."

Read-only verification (cannot execute tsc from this review mode):
- `tsconfig.test.json` includes `src/**/*.test.ts(x)` + `tests/**/*.ts`;
  excludes nothing per design (intentional override).
- Spec 022 release-proposal at line 50 named `useStore.ts` and
  `webPush.ts` as the pre-existing offenders.
- Spec 023's new test files imports surface:
  - `src/utils/seedVarianceDates.test.ts` imports `./seedVarianceDates`
    (a new file with clean strict types and one `import { fetchRecentEodDates }
    from '../lib/db'`); no transitive pull on `useStore.ts` or `webPush.ts`.
  - All Track A `.test.sql` files are SQL, not TypeScript, so out of
    scope for `tsc`.
  - The only TypeScript change is `src/components/cmd/NewReportModal.tsx`'s
    import swap (removing one import, adding another) — semantically
    equivalent, no type widening or narrowing.

Risk: minimal. Spec 024 still has to fix the pre-existing
`useStore.ts` / `webPush.ts` errors; spec 023 does not add to that
list. The architect's pre-existing list documented at spec 023 §4 holds
unchanged.

**Recommendation for spec 024's scope:**
- Run `npx tsc --noEmit -p tsconfig.test.json` on a clean checkout
  with `main` after spec 023 commits.
- The offender list should match: `src/store/useStore.ts` and
  `src/lib/webPush.ts`, both pre-existing.
- Once both are clean, wire `typecheck:test` into
  `.github/workflows/test.yml` as a third job (matrix-with-jest, no
  DB cold-boot needed) per spec 023 §4.

## Critical findings

None.

## Should-fix findings

None.

## Minor findings

1. **A2/A10 dev note inaccuracy.** The Files-changed bullet at
   `specs/023-retro-test-coverage/spec.md:1188-1191` says "A2 / A10
   set `purchase_orders.po_number` explicitly". Only A2 does; A10
   does not insert any `purchase_orders` rows. Cosmetic; the test
   files themselves are correct.

2. **`generate_po_number()` latent bug — file under hardening.**
   The `cast(substring(po_number from 4) as int)` in
   `20260405000759_init_schema.sql:226` will raise if any
   `po_number` row exists that doesn't match `PO-N+`. Not a spec
   023 problem (the test sidesteps it cleanly via explicit
   `po_number`), but worth surfacing as its own hardening task. The
   dev's inline comment at A2 lines 141-146 is the only on-disk
   record of this bug today.

3. **README.md:263 stale content claim.** Still says "CI deploy-gate
   workflow" landed as a Recent-change. The architect's B2 contract
   only covered lines 137 + 224; line 263 is out of scope. Flag for
   a future README-cleanup pass. Minor.

4. **A5 flake mitigation: `'23:59:59'` vs architect's `'23:59:59.999'`.**
   Dev landed second-precision; architect's text suggested
   millisecond-precision. Effectively equivalent for CI flake risk on
   a sub-second-precision wall clock. Minor; not actionable.

5. **A6 plan(8) and A8 plan(5) defensible against internally
   inconsistent architect §1 text.** Both dev choices match the
   architect's enumerated assertion lists, not the inconsistent
   plan-count lines. Architect should clean §1's prose-vs-list count
   alignment in any future spec to avoid the dev needing to choose.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  5 Minor findings (A2/A10 cosmetic doc nit, generate_po_number latent
  bug surfaced for a future hardening task, README.md:263 stale claim
  out of B2 scope, A5 precision-trivial difference, architect-side §1
  prose-vs-list count alignment for future specs). No block. The two
  documented dev deviations (A9 UPDATE-instead-of-delete and A2
  explicit po_number) are Approved Drift — both preserve the
  architectural contract while routing around live constraints the
  architect's literal prescription did not anticipate.
payload_paths:
  - specs/023-retro-test-coverage/reviews/backend-architect.md
