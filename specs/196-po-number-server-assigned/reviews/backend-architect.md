# Spec 196 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-11-09.
Spec status on entry: `READY_FOR_REVIEW` (not changed).

Files reviewed:
- `supabase/migrations/20261109200000_po_number_server_assigned.sql` (new)
- `supabase/tests/po_number_server_assigned.test.sql` (new, `plan(68)`)
- `supabase/tests/report_run_variance_formula.test.sql` (AC-16 working-tree change)
- `specs/196-po-number-server-assigned.md` (implementation notes, AC-19 table, Files changed)

## Verdict

**No drift from the design.** The migration matches D-2 statement by statement and the guard body matches D-3 exactly. The trigger wiring matches D-4. The test file follows the D-10 block plan and house rules. AC-16 matches D-10's instructions. I found 0 Critical, 1 Should-fix (release/staging only, not code) and 4 Minor/informational findings.

Counts: **Critical 0 · Should-fix 1 · Minor 4**

## Contract conformance (checked, no finding)

| Design item | Where | Result |
|---|---|---|
| D-1/D-2 version slot after every on-disk migration | `20261109200000` vs newest other file `20261109195000_user_stores_drop_own_row_writes.sql` | Still last on disk at review time. The three other 2026-11-09 migrations (`120000`, `191000`, `195000`) add no trigger on `purchase_orders` and write no `po_number` (grep). |
| D-2 step 2 `begin` + `lock_timeout = '5s'` | migration L71-73 | Match |
| D-2 step 3 spec 190 dependency `DO` guard, exact message, default P0001 | L76-82 | Match |
| D-2 step 4 / D-3 function: `security invoker` written out, `set search_path = public`, wiring check first, role literal `current_user not in ('anon', 'authenticated')`, INSERT `is not null`, UPDATE `is distinct from`, refusal `'po_number is server-assigned'` P0001, no DETAIL/HINT | L85-117 | Match. The body calls no function, reads no GUC and reads no table. The body comments contain no `jwt` or `auth.` token, so the AC-12 negative arms pass for the right reason. |
| D-2 step 5 one revoke from `public, anon, authenticated` | L119-120 | Match. The recorded local `proacl {postgres=X/postgres,service_role=X/postgres}` is what D-5 predicts (non-NULL, no PUBLIC/anon/authenticated entry, service_role keeps the spec 097 default). |
| D-2 step 6 function comment covers rule, string, INVOKER reason, no claims/functions/tables, name order, DEFINER residual, future-DEFAULT risk (D-13 #2) | L122-136 | Match |
| D-2 steps 7-8 idempotent drop/create, `before insert or update`, `for each row`, no column list, no `WHEN`; trigger comment with the ordering text | L139-150 | Match |
| R5 / AC-15 spec 190 objects untouched | migration | No statement touches `generate_po_number`, `format_po_number`, the sequence or `set_po_number`. |
| D-6 RLS: no policy change | migration | None. |
| D-7/D-8/D-9: no API, edge-function, `db.ts`, store or publication change | Files changed list + grep | Confirmed. Nothing under `src/`, `extension/`, `supabase/functions/` or `config.toml` changed. The only `po_number` writers outside tests are none (grep of `src`, `extension/src`, `supabase/functions`, `scripts`, `e2e`). `send-order-failure-email` only reads it. `scripts/smoke-po-number-concurrency.sh` (spec 190) inserts NULL numbers only, so it is unaffected. |
| D-10 house rules: refusals pinned by `throws_ok(..., 'P0001', 'po_number is server-assigned')`; allowed UPDATEs via `try_sql = 'ok:1'`; sequence read and `format_po_number` called only as postgres; explicit numbers `seq_next() + 10000 + k`, no `setval`; no `set role anon`; read-backs as postgres by fixture id | test file throughout | Match. 16 explicit numbers at k = 1..16, computed once after fixtures (L263-277). |
| D-10 AC-8 runs `receive_purchase_order` as `authenticated` through the client branch | test L371-378, read-back L611-616 | Correct. The current body is `20260707000000_staff_receiving_price_gate.sql:114-122` (`security invoker`), and no later migration redefines it. `ok:1` here is the SELECT's row count. The real proof is the `received/true` read-back, which is present. |
| D-10 AC-14 seven arms incl. `tgtype = 23`, empty `tgattr`, `tgqual is null`, `tgfoid`, first BEFORE ROW INSERT trigger (`tgtype & 7 = 7`) | test L140-187 | Match |
| D-10 anti-vacuity arms in D, E, H | L407-410, L451-454, L504-509 | Match |
| AC-16 fixture + comment | variance file L147-167 | Match. `po_number` is gone from the column list and value list, the comment carries the D-10 text, and `plan(7)` (L39) is unchanged. No other `po_number`/`SPEC023` reference is left. |

### `plan(68)` vs the ~60 estimate

This is not drift. D-10 gave an approximate count and left the exact `plan(N)` to the developer. My recount of the file matches the implementation notes exactly:

| Block | Arms |
|---|---|
| A (AC-13 6, AC-12 3, AC-14 7, AC-15 3) | 19 |
| C (AC-1 1, AC-2 2, AC-3 2, AC-4 1, AC-6 3, AC-7 2, AC-8 1, AC-5 2) | 14 |
| D (anti-vacuity 1, AC-1 1, AC-3 1, AC-5 2) | 5 |
| E (anti-vacuity 1, AC-1 1) | 2 |
| F / G (AC-9 1 + AC-10 1 each) | 2 + 2 |
| H (2 anti-vacuity + AC-11) | 3 |
| I read-backs (AC-1 2, AC-2 1, AC-3 1, AC-4 1, AC-5 5, AC-6 3, AC-7 2, AC-8 1, AC-9 2, AC-10 2, AC-11 1) | 21 |
| **Total** | **68** |

The gap from ~60 comes from the read-back block. D-10 described it as one line per AC, but some ACs need more than one arm: AC-5 has 4 rows plus a format arm, AC-6 has 3 rows, and AC-9 and AC-10 have 2 each.

### AC-19 mutation results are arithmetically consistent

I re-derived each recorded failure count from the arm list above:
- Trigger dropped, 20: 9 refusal arms + 5 refusal read-backs + 6 name-keyed AC-14 arms. The literal-compare arm can't fail.
- Made DEFINER, 15: AC-13 `prosecdef` + 9 refusals + 5 read-backs.
- Renamed to `zz_…`, 15: 4 AC-5 `lives_ok` + 5 AC-5 read-backs + 6 name-keyed AC-14 arms.
- SET-list variant, 4: AC-7 ×2 + P10 read-back + AC-14 `tgattr`.
- Role widened, 11: AC-9/10/11 (5) + their read-backs (5) + AC-12 `prosrc`.
- `anon` removed, 1: AC-12 `prosrc`.

Every count matches, so the table looks like a real run and not a guess.

## Findings

### Critical

None.

### Should-fix

**SF-1. The AC-16 edit must land in the same commit as the spec 196 migration (staging hazard, not a code defect).**
`supabase/tests/report_run_variance_formula.test.sql` is `MM`. The index holds the earlier spec 190 comment change. The spec 196 edit (L147-158) is an unstaged working-tree change on top of it. The implementation notes (spec L509) confirm that with the migration applied and without this edit, the file fails at its PO insert with `po_number is server-assigned`. That would turn `test.yml` red on `main`. The reverse split is safe: the AC-16 edit alone also passes under spec 190, because it only omits a column. So the rule is one-way: **never commit `20261109200000_po_number_server_assigned.sql` without the working-tree hunk of the variance file.** When the user stages:
- `git add supabase/tests/report_run_variance_formula.test.sql`. This folds the spec 196 hunk into the index together with the spec 190 hunk. That is correct if 190 and 196 ship in one commit.
- If 190 ships in an earlier commit, it is fine for that commit to carry either version of the file. The 196 commit must include the final version.

The release coordinator should carry this into the commit checklist, next to the existing D-11 order (190 on prod, then 194/195000 on prod, then 196 on prod, then push).

### Minor

**M-1. The AC-14 literal-compare arm is a tautology on its own** (test L174-177). `'purchase_orders_po_number_guard_trg' collate "C" < 'set_po_number' collate "C"` compares two constants, so no catalog state can make it fail. The AC-19 rename mutation confirms this: that arm is not among the 6 AC-14 failures. The spec's AC-14 asked for this exact assertion, and the real protection is the first-BEFORE-ROW-INSERT arm (L178-187), which did fail under the mutation. No change needed. I am recording it so nobody counts it as independent coverage later.

**M-2. The AC-6 P8 read-back depends on the column's scale** (test L593-598). It compares `total_cost::text || …` against `'42.00/true'`. That pins `total_cost` to a 2-decimal scale, so a future widening (spec 104 widened cost columns to `numeric(12,6)`) would break the arm with no change in behaviour. `(total_cost = 42)::text` would be scale-proof. Optional.

**M-3. Block C has no explicit staff anti-vacuity arm.** Blocks D and E open with `ok(auth_can_see_store(S))` because a BEFORE trigger fires before the RLS `WITH CHECK` (D-4). Block C does not. Staff visibility is still proven in the same file: the AC-5 staff `lives_ok` inserts and the AC-6 `ok:1` updates can only pass if staff can write store S. So the AC-1/AC-2 staff refusals are not vacuous. D-10 did not ask for a C-block arm, so this is not drift.

**M-4. The AC-12 negative regexes scan the whole `prosrc`, comments included** (test L128-137). A future body comment that mentions `jwt` or `auth.` would fail these arms even if the behaviour did not change. That fails loudly in the safe direction and is acceptable. If it ever trips, the fix is to reword the comment, not to loosen the regex.

## Not in scope of this review (gated, unchanged)

- AC-20 / AC-21 / AC-22 (prod apply, prod verification, CI after push) are open and correctly marked unchecked. They wait for the owner's go-ahead and follow D-11. The local normalized md5 `f64474e39f32bb6b2a8c90995295b9eb` is recorded in the spec for the AC-21 comparison.
- D-14 "noticed, not changed" items are still open as designed.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 6 findings by severity: 0 Critical, 1 Should-fix (SF-1, staging: the unstaged AC-16 hunk must ship with the 196 migration), 4 Minor.
payload_paths:
  - specs/196-po-number-server-assigned/reviews/backend-architect.md
