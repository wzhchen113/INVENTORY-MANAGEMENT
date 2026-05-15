# Backend-architect post-impl drift review for spec 037

I authored the §1-§17 design that the developer implemented against. My
job here is to judge whether the implementation matches the design, and
to disposition the two deviations the developer surfaced. I deliberately
do NOT re-grade what the code-reviewer and test-engineer have already
covered (Jest test missing, sanitization-branch coverage gaps, etc.) —
those are their lane. My findings are scoped to **architectural drift**:
where the implementation diverged from the contract I pinned, where
that contract was wrong, and where the remaining envelope is sound.

---

## Disposition of the two dev-surfaced deviations

### Deviation 1 — Guard 2 (`SET LOCAL statement_timeout`) does not fire inside plpgsql

**Verdict: dev is correct. Design §4 / §16 / §A2 was wrong on my part.**

I asserted in §4 ("Confirmed `SET LOCAL statement_timeout` does fire
inside a `security invoker` function body — Postgres applies it before
the next statement, and the wrapped `EXECUTE` is the next statement
after the `SET LOCAL`s") and again in §16 ("Confirmed it fires").
Neither claim is empirically true.

Postgres semantics:
- `statement_timeout` is checked at **top-level** statement-start, not
  on each inner plpgsql `EXECUTE`. Within a function call, the outer
  RPC call IS the statement; `SET LOCAL` only configures what timeout
  will apply to the **next top-level statement** in the same
  transaction.
- The `authenticated` role's connection-level default
  (`statement_timeout = 8s`) is armed at session startup and IS the
  operative budget across the whole RPC call. The dev's empirical
  finding is consistent with documented Postgres behavior.
- `WHEN OTHERS` in plpgsql does NOT match `query_canceled` (57014)
  per the Postgres docs (https://www.postgresql.org/docs/current/plpgsql-control-structures.html
  — "The special condition name OTHERS matches every error type
  except QUERY_CANCELED and ASSERT_FAILURE"). The explicit
  `when query_canceled` arm in the runner is the ONLY path that can
  catch a timeout. That arm DOES fire when the role-level 8s wall
  trips. So the sanitization path IS active — just on the 8s budget,
  not the 5s budget I designed.

**Security envelope impact:** preserved. Runaway queries are still
killed; the user-facing message just says "5s" while the actual ceiling
is 8s. This is a documentation/SLA-honesty problem, not a security
problem. A DoS attacker can extract 8 seconds of compute per call
instead of 5 — but they were already privileged to call
`report_run_custom` and could just call it again.

**Design amendment:**
1. The `SET LOCAL statement_timeout = '5s'` line should STAY (intent
   documentation + future-tightening hook, as the dev kept it).
2. The user-facing message should say `"timed out after 8s"` not
   `"timed out after 5s"`, matching reality. Same change in the modal
   hint string (`NewReportModal.tsx:467` says `"5s timeout"` — the
   code-reviewer flagged this independently). Either bump everything
   to 8s or leave at 5s with a note that the budget is "best effort"
   to the role-level default. I lean toward 8s — operators should
   trust the displayed SLA literally.
3. Spec §A2 grid: Guard 2's "Mechanism" should read
   `connection-level statement_timeout on authenticated role (8s)`
   rather than `SET LOCAL statement_timeout = '5s'`. Spec §16 first
   bullet ("Confirmed it fires") should be replaced with the
   empirical finding.

### Deviation 2 — Guard 1 (`SET LOCAL transaction_read_only = on`) arm is unreachable through the SELECT-wrap

**Verdict: dev is correct. Design §4 (the `format('select * from (%s)
_spec037_user_sql limit 1001', ...)` wrap) creates the unreachability
the dev observed.**

The `select * from (%s)` wrap is a subquery context. Postgres parses
this BEFORE evaluating it. INSERT/UPDATE/DELETE/CREATE/etc. are not
valid SELECT subquery sources, so the parser rejects them with
`42601 syntax_error` long before the `transaction_read_only = on` flag
gets a chance to fire. The dev correctly observes:

- Bare INSERT/UPDATE/DELETE/TRUNCATE/COPY → 42601 syntax_error (parse
  rejection of "not a SELECT").
- DDL (CREATE/DROP/ALTER) → 42601 syntax_error (same).
- CTE-wrapped data-modifying statements (`WITH x AS (INSERT ...
  RETURNING ...) SELECT * FROM x`) → 0A000 feature_not_supported
  (Postgres rejects "data-modifying CTEs must be at the top level"
  when the CTE is buried inside a sub-SELECT).

**Security envelope impact:** preserved, possibly stronger than my
design. The parse-time rejection is STRICTER than the runtime
read_only_sql_transaction check would have been — the user can't even
reach the EXECUTE stage with a write attempt. The `when
read_only_sql_transaction` arm is dead code through the current wrap,
but the `when syntax_error` arm catches both bare-DML and bare-DDL
attempts safely, and the `when others` arm catches the CTE-wrapped
case (re-raised as the generic "run failed" message instead of "only
SELECT statements are allowed").

**Design amendment:**
1. The `when read_only_sql_transaction` arm should STAY as
   defense-in-depth documentation (in case a future spec removes the
   SELECT-wrap and the read-only flag becomes load-bearing).
2. The migration's inline comment at line 215 (`-- Guard 1 trips here
   for DML/DDL`) is now misleading — it should be reworded to say
   "Defense-in-depth intent; currently unreachable through the
   SELECT-wrap. See header caveat." The code-reviewer also flagged
   this independently as Nit 5.
3. Spec §A2 grid: Guard 1's "What it catches" should read `DML/DDL via
   parse-time rejection in the SELECT-wrap (42601 syntax_error or
   0A000 feature_not_supported); the read_only_sql_transaction arm is
   defense-in-depth for future wrap-removal`.
4. The test arms 6/7 correctly assert the empirical reality (42601 with
   `'syntax error'` message). The architect-pinned `25006 → 'only
   SELECT statements are allowed'` message is preserved in the runner
   but unreachable. Acceptable.

**Both deviations are empirically forced reality, not design choices
the dev should have pushed back on. The security envelope remains intact
in both cases.** I'm closing out both deviations as DISPOSITIONED-
ACCEPT-WITH-AMENDMENTS.

---

## Drift findings (Critical → Should-fix → Nits)

### Critical

**Critical 1 — pgTAP arm 8 (RLS cross-store enforcement) silently dropped, not just substituted.**

The dev's deviation writeup names two substitutions: Guard 1
(unreachable) and Guard 2 (untestable). What it does NOT name is a
THIRD drop: my §15 arm 8 ("RLS enforced — privileged Frederick admin
calling `SELECT * FROM public.inventory_items WHERE store_id =
'<charles-id>'::uuid` returns 0 rows") is missing from the test file
entirely. The test file's arm 8 is the schema-lockout assertion
(architect's arm 9). The dev's writeup describes arm 8 as a
substitution for the timeout arm (architect's arm 10), but the RLS
arm has no substitute — it was deleted.

This is the load-bearing test for the spec's central security claim:
"RLS, not lexical inject" (PM §A2.4, my design §A2 grid row 4). The
whole reason the spec accepted free-text SQL is that `security
invoker` + per-store RLS gates cross-tenant reads. Without an
automated test for that property, the regression detection story is
"hope nobody flips the runner to `security definer` someday."

The arm is straightforward to write — no fixture pgTAP wrinkles, no
`pg_sleep` runtime cost. It exercises the same wrapped EXECUTE path
the test already uses, just with a different user SQL. The omission
is unjustified.

**Disposition:** add the missing arm before SHIP_READY. Both
code-reviewer (Should-fix #2) and test-engineer (Critical 1)
independently flagged this. As the architect, I'm raising it to
Critical: this is the only test of Guard 4 (RLS via security invoker),
which is one of the five guards the design's defense-in-depth claim
rests on.

**Reference shape:**
```sql
-- Admin (member of Frederick AND Charles per seed) explicitly
-- queries Charles via a Frederick-scoped runner call. RLS on
-- inventory_items must filter the row out before the user's WHERE
-- even matters.
select is(
  (select jsonb_array_length(
    (public.report_run_custom(
      current_setting('test.frederick_id', true)::uuid,
      jsonb_build_object(
        'sql',
        format(
          'SELECT id FROM public.inventory_items WHERE store_id = %L::uuid LIMIT 5',
          current_setting('test.charles_id', true)
        )
      )
    ))->'rows'
  )),
  0,
  'RLS enforced: cross-store inventory_items query returns 0 rows (not the actual Charles rows)'
);
```

Note: the seed admin is `11111111-...` which is a member of all stores,
including Charles. So this test specifically depends on RLS filtering
by `auth.uid()` and `auth_can_see_store()` at the policy level — exactly
what we want to verify.

### Should-fix

**Should-fix 1 — `_row_count` field is emitted, typed, and never consumed.**

My design §6 promised `_row_count` would "let the FE render '1000 rows'
/ '47 rows' in the table header without a second `.length` read." The
field IS in the envelope, IS in the TypeScript type, but is NOT rendered
anywhere in `ReportDetailFrame.tsx`. The `ResultTable` and the
truncation hint both ignore it.

This is design drift on my part — I committed to a frontend usage that
the design's FE file edits didn't actually include. The code-reviewer
also flagged this (Nit 3). Possible resolutions:
1. Add a tiny "N rows" label above the `ResultTable` for custom
   reports (consistent with the original design intent).
2. Remove `_row_count` from the envelope and the TypeScript type (no
   consumer needs it; the FE can `rows.length` on its own).

I lean toward (1) — keep the field, add the label. The field is cheap
to compute server-side and the FE can avoid a second array length
traversal. But (2) is defensible if the FE never wants to render it.
This is a JUDGMENT-CALL drift, not a security or contract drift. Flag
to PM for the call.

**Should-fix 2 — Modal hint text says "5s timeout" but the operative budget is 8s.**

The hint string at `NewReportModal.tsx:467`:
```
'SELECT only · public.* tables · 5s timeout · max 1000 rows · RLS-filtered to your stores'
```

per the dev's Deviation 1 disposition (which I just accepted), the
actual budget is the role-level 8s default — `SET LOCAL
statement_timeout = '5s'` inside the function body does nothing. The
user sees `5s` in the UI hint but a query that runs for 6 seconds will
still succeed.

This is operator-facing dishonesty introduced by accepting Deviation 1
without updating the FE copy. The user-facing exception message in
the runner still says `"Custom SQL: timed out after 5s"` (line 213)
which is the same kind of dishonesty.

Either:
1. Bump both strings to 8s (matches reality).
2. Bump both strings to "5s timeout (best-effort; 8s ceiling)" (more
   precise but verbose).

Code-reviewer flagged this independently as Should-fix #4. I support
their fix.

**Should-fix 3 — `WHEN OTHERS` arm raises `errcode = 'P0001'`, which collides with other plpgsql RAISE-EXCEPTION sites.**

Line 246 of the migration uses `using errcode = 'P0001'`. P0001 is the
default SQLSTATE for unqualified `RAISE EXCEPTION` and is used by
`assert_not_last_of_role` (spec 014) and the variance runner. A future
caller-side branch in `db.ts` that wants to detect "custom SQL run
failed (catch-all path)" specifically cannot distinguish this from
"last super_admin guard tripped" by SQLSTATE alone — only the message
text differs.

Code-reviewer flagged this as Should-fix #3. The design did not pin a
specific SQLSTATE for the catch-all (§5 table just says `'others' →
'Custom SQL: run failed'`); the dev picked P0001 as the default. A
SQLSTATE in the P05xx range (which Postgres reserves for application
use) like `'P0501'` would be unambiguous.

**Disposition:** the design omitted a SQLSTATE choice for the
catch-all; the dev's choice of P0001 is reasonable per Postgres
convention but creates the collision. I'd amend the design to pin
`'P0501'` for future clarity, but this is not a security or contract
break — the current `db.ts` matches on the message prefix
(`'Custom SQL'`), not the SQLSTATE. Either fix in this spec or as a
follow-up cleanup.

### Nits

**Nit 1 — Spec §15 arm 2 (fixture sanity for 'user'-role member) was repurposed to "Charles store id resolves."**

My §15 plan(13) named arm 2 as `Fixture sanity: a non-privileged
'user'-role member exists for the privilege gate`. The dev used the
arm slot for a different fixture sanity (Charles id resolves) and put
the user-role JWT inline within arm 3. The substitution is functionally
equivalent — if the manager seed user didn't exist, arm 3 would fail
loudly. Arm 4 needs the Charles id, so spending arm 2 on that is fine.
No drift; just renumbering.

**Nit 2 — Migration comment at line 26 references "pgTAP arm 8 for the end-to-end demonstration" of timeout, but the actual arm 8 is schema lockout.**

The migration header comment promises the timeout property is
demonstrated via pgTAP arm 8 (via a SESSION-level timeout set outside
the call). The actual arm 8 in the test file is the schema-lockout
assertion. The dev's deviation writeup correctly documents that the
timeout arm was substituted, but this in-line breadcrumb in the
migration header is now stale.

**Disposition:** trivial. Reword the line 26 reference to "see the
migration header's Guard 2 caveat for why pgTAP cannot directly
exercise the timeout path."

**Nit 3 — `reports_anon_revoke.test.sql` header comment cites "12 RPCs covered" but the bullet body enumerates 11 distinct RPCs.**

The dispatcher + 10 individual runners = 11 RPCs. The 12th item in
`plan(12)` is the fixture sanity arm (Frederick resolves), not an RPC.
The comment is internally inconsistent but does not affect any
assertion. Code-reviewer flagged this independently as Nit 1.

**Nit 4 — `byOpts` ternary refactor correctly deferred.**

My §A0 #4 deferral resolution (custom has no by-axis; ternary doesn't
widen) is correctly honored — `ReportDetailFrame.tsx:283-287` shows
the ternary unchanged. No drift.

---

## Architecture envelope: PASS, with documented caveats

The five-guard sandbox claim holds in spirit:

| Guard | Design claim | Reality | Envelope intact? |
|-------|-------------|---------|-------------------|
| 1 — Read-only | SET LOCAL transaction_read_only = on; DML/DDL → 25006 sanitized | Unreachable through SELECT-wrap; DML/DDL → 42601 (parse-time) | YES (stronger; parse-time block) |
| 2 — Timeout | SET LOCAL statement_timeout = '5s' | Inert inside plpgsql; role-level 8s default IS operative | YES (just 8s not 5s) |
| 3 — Row cap | LIMIT 1001 outer wrap; truncate to 1000 | Works as designed | YES |
| 4 — RLS | security invoker + caller UID + RLS policies | Works as designed; UNTESTED | YES (but no test) |
| 5 — Schema lockout | GRANT-level deny on auth.* / pg_* | Works as designed | YES (tested via arm 8) |
| Plus — Privilege gate | auth_is_privileged() raise 42501 outside sandbox | Works as designed | YES (tested via arm 3) |

The whole point of the spec is that a privileged caller can write any
SELECT against `public.*` and get RLS-filtered results back. That
property holds. The two empirical deviations narrow the SLA precision
(8s not 5s) and the failure-class semantics (parse-time syntax-error
not run-time read-only-violation) without weakening the guarantees.

**Recommendation:** ship-ready BLOCKED on the missing RLS-enforcement
test arm (Critical 1). Fix that, address the design amendments to
spec §A2 / §16 / §5 (catalogued above), and the implementation is
correct.

---

## Boundary check

| Surface | Touched? | Expected? |
|---------|----------|-----------|
| `supabase/migrations/` (one new file) | YES | YES |
| `supabase/tests/` (one new + one edit) | YES | YES |
| `supabase/functions/` (edge functions) | NO | YES — RPC-only per §9 |
| `supabase/config.toml` | NO | YES |
| `src/lib/db.ts` (allowlist extension) | YES | YES |
| `src/types/index.ts` (optional fields) | YES | YES |
| `src/screens/cmd/sections/reports/templates.ts` | YES | YES |
| `src/components/cmd/NewReportModal.tsx` | YES | YES |
| `src/screens/cmd/sections/reports/ReportDetailFrame.tsx` | YES | YES |
| `src/screens/cmd/sections/ReportsSection.tsx` | YES | YES |
| `src/store/useStore.ts` | NO | YES — §12 said no changes |
| `app.json` | NO | YES (per CLAUDE.md slug pinning) |
| Realtime publication | NO | YES — `report_runs` already publishes |
| `docker restart supabase_realtime_imr-inventory` | NOT REQUIRED | per §13 |

**No unintended file touches.** The implementation scope matches the
design scope.

---

## Post-merge deploy

Dev correctly did NOT run `npx supabase db push --linked --yes`. This
is the user's call, post-review. The migration is additive (one new
function + one `create or replace` of the dispatcher) and rolls back
cleanly via `drop function if exists` + dispatcher re-create per
§1's rollback-safety note.

---

## Files referenced

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260515130000_report_run_custom.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/report_run_custom.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/reports_anon_revoke.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts` (lines 1916-1940)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts` (lines 540-569)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/templates.ts` (line 17, line 36)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/NewReportModal.tsx` (lines 129-178, 283-326, 339-358, 442-469)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/ReportDetailFrame.tsx` (lines 156-164, 377-422, 456-492, 894-941)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReportsSection.tsx` (lines 235-282)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/037-reports-custom-template/spec.md` (architect §A1-§A17 design, dev deviation writeup at §"Known deviations")
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (lines 235-243 for `auth_is_privileged` definition)

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 1 Critical (missing
  RLS-enforcement pgTAP arm), 3 Should-fix (unused `_row_count`,
  modal hint says 5s but reality is 8s, catch-all SQLSTATE P0001
  collision), 4 Nits. Both dev-surfaced deviations
  DISPOSITIONED-ACCEPT-WITH-AMENDMENTS — security envelope intact,
  spec §A2/§16/§5 to be amended to match empirical reality.
payload_paths:
  - specs/037-reports-custom-template/reviews/backend-architect.md
