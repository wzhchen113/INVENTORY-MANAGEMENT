# Security audit for spec 037 — Reports: Custom SQL template

Read [CLAUDE.md](CLAUDE.md), spec.md, and every file in §Files changed.
Independently exercised the runner against the live local Postgres
17.6 stack via `docker exec supabase_db_imr-inventory psql` to verify
attack vectors. All pgTAP arms pass (plan(13) + plan(12) extended).

This template is the most security-sensitive Reports template to date
— power users supply free-text SQL. The defense-in-depth grid (the
two privilege gates BEFORE the inner begin/exception, plus the
`SELECT-wrap + read-only + RLS + schema-lockout + sanitization-wall`
sandbox inside it) holds up against every attack vector I tried.
Verdict: **no Critical, no High blockers**. A handful of Medium and
Low findings below — none of them blocks merge — but two of them are
worth thinking about before the next iteration adds a more permissive
gate.

---

### Critical (BLOCKS merge)

**None.** I exercised every attack vector the prompt named and
several it did not (paren-balanced SQL injection through the `%s`
wrap, statement-chain injection via embedded `;`, CTE-INSERT, UNION
against `auth.users`, `pg_read_file`/`pg_ls_dir`/`pg_terminate_backend`,
disabling `transaction_read_only` mid-execution, recursive runner
invocation). None reach data the caller couldn't already see, none
write, none escalate privilege beyond the admin/super_admin role
the caller already has.

The two architect-flagged deviations
([spec.md:1568-1626](specs/037-reports-custom-template/spec.md)) —
`SET LOCAL statement_timeout` is a no-op inside the function body,
and the `when read_only_sql_transaction` arm is unreachable through
the SELECT-wrap — are both **Acceptable**, not Critical:

1. The runtime budget reverts to the `authenticated` role's
   connection-level 8s default, which IS armed at PostgREST startup
   and DOES bound the entire RPC call (verified by the wall-clock
   behavior in pgTAP arm 8 and through manual probes). 5s vs 8s is
   a documentation drift, not a security gap.
2. DML/DDL is blocked at parse-time by the SELECT-wrap (verified
   below for bare INSERT, bare CREATE TABLE, CTE-wrapped INSERT, and
   COPY). The user gets the wrong sanitized message ("syntax error"
   rather than "only SELECT statements are allowed") but the write
   never happens.

The migration header documents both correctly. Test arms 6 / 7 / 8
in [supabase/tests/report_run_custom.test.sql](supabase/tests/report_run_custom.test.sql:137-198)
pin the actual SQLSTATEs / messages so the spec-pinned ones don't
drift back in via copy-paste from the velocity / vendor / waste
runners.

---

### High (must fix before deploy)

**None.**

---

### Medium

1. `supabase/migrations/20260515130000_report_run_custom.sql:184` —
   **A privileged caller can mutate session-level GUCs from inside
   the runner**, including `request.jwt.claims`, by passing
   `set_config(..., is_local := false)` in the user SQL.

   Repro (verified):
   ```sql
   select public.report_run_custom(
     '<store>'::uuid,
     jsonb_build_object('sql',
       'SELECT set_config(''request.jwt.claims'',
          ''{"sub":"<other-uid>","role":"authenticated","app_metadata":{"role":"user"}}'',
          false)')
   );
   -- After this call returns, in the same session:
   select auth.uid();   -- → <other-uid>
   ```

   Why this is Medium (not Critical):
   - The caller is already admin / super_admin per `auth_is_privileged()`,
     so they already have everything `auth.uid()`-gated visibility
     they would gain by swapping the JWT. There's no net access
     escalation.
   - In the standard Supabase PostgREST flow, every HTTP request
     starts with `set_config('request.jwt.claims', <jwt>, true)`
     (is_local=true → transaction-scoped). The attacker's
     `is_local=false` change persists across transactions in the
     session, but the next HTTP request overwrites it before any
     user SQL runs. So inter-request bleed is bounded by PostgREST's
     own per-request `set_config`.
   - `transaction_read_only = on` does NOT block GUC writes
     (`set_config` and `SET` are not "writes" in the Postgres
     `25006` sense — verified). This is by design.

   Why it's worth flagging:
   - Audit trails on tables that record `auth.uid()` in a server
     `default` (e.g. `report_runs.ran_by`, `audit_log.actor_id` if
     such columns exist) would record the spoofed UID, not the real
     caller's. An admin could deliberately attribute their actions
     to another user.
   - If a future spec adds a non-PostgREST consumer that shares a
     connection pool with PostgREST (a `pg_cron` job, a one-off
     `psql` invocation from supabase studio, etc.) and that consumer
     does NOT issue its own `set_config('request.jwt.claims', ...)`,
     the attacker's leftover GUC could affect it.
   - The runner has the option to lock `request.jwt.claims` for the
     duration of the EXECUTE by snapshotting before the sandbox
     opens and restoring after. The simplest fix is to drop a
     `set local request.jwt.claims = '<original>'` after the
     EXECUTE returns (whether by success or by exception) so any
     user-modified version reverts. The current `is_local=true`
     reset at the beginning of each request makes this defense-
     in-depth rather than load-bearing today.

   Recommended fix (deferred — not blocking): add a `revoke execute on
   function pg_catalog.set_config(text, text, boolean) from authenticated`
   pass in a follow-up spec, OR snapshot+restore `request.jwt.claims`
   inside the sandbox block. The latter is more surgical (you don't
   want to also break legitimate `set_config('search_path', ...)`
   calls from elsewhere). Either way: not in scope for spec 037.

2. `supabase/migrations/20260515130000_report_run_custom.sql:200-208` —
   **`pg_catalog` system views and metadata are readable to any
   privileged caller** via the runner.

   Repro (verified):
   ```sql
   select public.report_run_custom(...,
     'SELECT name, setting FROM pg_settings LIMIT 5');
   select public.report_run_custom(...,
     'SELECT rolname, rolsuper FROM pg_roles');
   select public.report_run_custom(...,
     'SELECT relname FROM pg_class WHERE relnamespace = ''auth''::regnamespace');
   select public.report_run_custom(...,
     'SELECT pid, usename, query FROM pg_stat_activity');
   ```

   `pg_settings` exposes the entire Postgres configuration (no
   secrets directly, but reveals architecture). `pg_roles` reveals
   every Postgres role and the `rolsuper` flag (useful for an
   attacker scoping next moves). `pg_class` reveals every table
   name in every schema including `auth.*`, `storage.*`, `vault.*`
   — even though the row data of those tables is blocked by
   `revoke select`. `pg_stat_activity` reveals other live sessions'
   PIDs and role names (query text is censored as
   `<insufficient privilege>`).

   `pg_authid` IS correctly locked down → 42501.

   Why this is Medium (not Critical / High):
   - The privilege gate restricts callers to admin / super_admin.
     The audience for free-text SQL is the operator team; they
     already have access to the supabase studio (where `pg_catalog`
     is also readable). No net new disclosure.
   - The "schema lockout via grants" guard documented in §A2.5
     covers the row data of `auth.*` / `storage.*`. The catalog
     metadata is a separate Postgres convention (default-public on
     most pg_* views) that the spec did not pin as part of the
     guarantee.

   If the audience for custom SQL widens beyond admins in a future
   spec (e.g. extending to `master` role per spec.md:488-490 §Out
   of scope), pg_catalog visibility becomes a real consideration.
   Today: documented gap, not a blocker. Worth a header bullet in
   the migration calling out that pg_catalog views are reachable
   for the future-tightening reviewer.

3. `supabase/migrations/20260510120000_report_runs.sql:114-116` and
   `supabase/migrations/20260510120000_report_runs.sql:146-148` —
   **The persisted SQL in `report_definitions.params` and
   `report_runs.params` is readable by any store member**, including
   plain user-role members who cannot themselves run custom SQL.

   The RLS on both tables is `auth_can_see_store(store_id)`. A plain
   user-role member of the store gates through (they CAN see the
   store) and can `select params from public.report_definitions
   where template_id = 'custom'` to read every saved custom SQL
   the admin has defined.

   Why this is Medium (low end):
   - The SQL string itself is metadata, not secrets. Typical custom
     SQL like `SELECT name, count(*) FROM public.inventory_items
     GROUP BY name` reveals nothing the user can't read directly
     anyway.
   - The OUTPUT envelope persisted in `report_runs.output` is also
     readable per the same RLS — and that output is filtered by RLS
     at execution time, so user-role members can read the persisted
     output rows that the admin saw. No cross-store leak: an admin
     who runs custom SQL on Frederick produces output that's
     readable only to Frederick members (and admins/super_admins).
   - `report_runs` is NOT in the realtime publication
     (`20260514140000_realtime_publication_tighten.sql:43-53`) so
     a saved custom run doesn't broadcast over WebSocket. The leak
     is "user looks at the saved-definitions list and sees the SQL
     text"; not "user subscribes and watches admin's queries live."

   If operators routinely embed sensitive WHERE clauses (e.g.
   `WHERE customer_email = ...`) in their custom SQL, this becomes
   real. Recommend: a follow-up spec could narrow the
   `report_definitions` SELECT policy to `auth_is_privileged()` for
   the row where `template_id = 'custom'` specifically (custom
   definitions are admin-authored anyway; plain users have no need
   to read them). Not a blocker for v1.

---

### Low

1. `supabase/migrations/20260515130000_report_run_custom.sql:200-208` —
   **The `%s` substitution into `format()` is the documented attack
   surface; it is empirically safe through the SELECT-wrap.**

   Verified attack vectors (all blocked):
   - `1) UNION SELECT * FROM auth.users--` → 42601 syntax_error
     (the trailing `--` doesn't comment out the wrap's closing
     `_spec037_user_sql limit 1001 ) as _outer_row`; the parser
     hits an unbalanced paren).
   - `1) FROM auth.users; DROP TABLE x; --` → 42601 syntax_error
     (same reason).
   - `1) /* --` → 42601 syntax_error (the block-comment isn't
     terminated, so the wrap's suffix gets consumed as part of the
     comment, then the wrap's trailing `*/` or any later token
     causes a parse error).
   - `SELECT 1)) _u; DROP TABLE x; SELECT 1 FROM ((SELECT 1` (a
     paren-balanced statement-chain attack) → 42601 syntax_error
     (the injected `DROP TABLE` is fenced inside a sub-SELECT
     position that's not a valid context for DDL — Postgres parses
     the wrap as ONE statement, not a chain, because the trailing
     `) as _outer_row` makes the whole thing a single SELECT
     expression-context).
   - `WITH ins AS (INSERT INTO public.audit_log ... RETURNING *)
     SELECT * FROM ins` (CTE-INSERT inside the wrap) → 0A000
     `feature_not_supported` → mapped to "Custom SQL: run failed
     — check the server logs" via the `when others` arm. Security
     intact; the message is generic rather than specific.
   - `INSERT INTO public.audit_log (action) VALUES ('hack')` (bare
     DML) → 42601 syntax_error (INSERT is not a valid SELECT-
     subquery source).
   - `CREATE TABLE x (y int)` (bare DDL) → 42601 syntax_error
     (same).

   Why this is Low (not informational):
   - The `%s` substitution is intentional and the security model
     is "RLS + grants + parse-time-wrap, not lexical SQL parsing."
     Spec.md §A2 §"Sandboxing — five hard guards" §1 nails this
     posture. Documentation is good.
   - No vector I could construct broke out. If a future Postgres
     version relaxes the "DML inside subquery" parse rule, the
     `when read_only_sql_transaction` arm becomes load-bearing —
     it's there as defense-in-depth. The arm has no test coverage
     (test arm 6 / 7 hit 42601 not 25006), so a regression in the
     read-only behavior would be silent. Worth a "this arm is
     forward-compat insurance — its absence of test coverage
     is intentional" line in the migration header. Today: header
     already says this implicitly via the "documentation of
     defense-in-depth intent" phrasing.

2. `supabase/migrations/20260515130000_report_run_custom.sql:208` —
   **`EXECUTE` accepts multi-statement strings** in PL/pgSQL.
   Verified:
   ```sql
   do $$
   declare v_x int;
   begin
     execute 'select 1; select 2' into v_x;
     raise notice 'v_x=%', v_x;  -- → 2 (last statement wins for INTO)
   end $$;
   ```

   This is a Postgres property, not a runner-specific issue. The
   wrap's prefix/suffix paren structure ensures any `;`-injected
   payload makes the WHOLE string syntactically invalid (verified
   above), so multi-statement injection is blocked even though
   `EXECUTE` would in principle execute multiple statements.
   No fix needed — flagging for future reviewers so they don't
   assume `EXECUTE INTO` is single-statement-safe.

3. `src/lib/db.ts:1924-1936` — **The `Custom SQL` startsWith
   allowlist is strict-prefix and won't collide with other RPC
   error messages.**

   Postgres RAISE messages from other paths don't start with
   `Custom SQL` because the sanitization wall is the only producer
   of that prefix in the codebase. The allowlist is narrow enough
   that a misbehaving caller can't trigger a false-positive on a
   different RPC path. Verified: searched the migrations for
   `raise exception 'Custom SQL` and only the spec-037 migration
   matches.

4. `supabase/migrations/20260515130000_report_run_custom.sql:200-208` —
   **The result-row cap is enforced INSIDE the wrap, but
   aggregate / window functions evaluate over the full
   pre-LIMIT row set**, so an admin can compute statistics over
   their full RLS-filtered visibility while only seeing 1000 of
   the rows.

   Repro (verified):
   ```sql
   select public.report_run_custom(...,
     'SELECT n, sum(n) OVER () AS total_sum
        FROM generate_series(1, 5000) n');
   -- rows[0] = { n: 1, total_sum: 12502500 }   ← sum(1..5000)
   -- rows.length = 1000
   ```

   Not a security issue (RLS still applies to the input rows; the
   admin has access to that data anyway). Flagging only because
   the spec.md §16 "Result cap accuracy" rationale doesn't call
   out that derived aggregates are computed over the full input,
   not the truncated output. Future reviewers reading the result-
   cap as "the admin can't compute statistics over more than 1000
   rows" would be wrong.

5. `supabase/migrations/20260515130000_report_run_custom.sql:208` —
   **The `EXECUTE format(...)` interpolation reveals the user's SQL
   in Postgres error logs via the `raise log` calls** in the
   exception arms.

   The `raise log 'report_run_custom: ... : %', sqlerrm` lines log
   the SQLERRM, which on many error classes contains the
   user-supplied SQL fragment (e.g. `column "foo" does not exist
   at character 12 — SELECT foo FROM bar`). The query text is in
   the operator's log stream — visible via `supabase logs` or
   direct Postgres log access.

   Not a security issue: the operator (admin tier) is the same
   audience as the SQL-author. Just flagging that "anything an
   admin types into the textarea ends up in the log stream" — if
   an admin pastes their personal Slack token into a SQL comment
   (e.g. `-- TODO: cron this with token xoxb-...`), it would be
   logged. Standard hygiene; not actionable in spec 037.

6. `src/components/cmd/NewReportModal.tsx:442-468` and
   `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:482-490` —
   **Frontend SQL rendering uses React Native `<Text>`** which
   escapes content by default. No `dangerouslySetInnerHTML`,
   no `innerHTML`, no `eval`, no `Function(...)` constructor.
   The textarea's `onChangeText` writes to state without
   transformation. The saved SQL display reads the saved string
   verbatim into a `<Text>` body.

   No XSS surface. Documenting that I checked.

---

### Dependencies

No `package.json` changes — `npm audit` skipped.

---

### Independent verification record

Ran (all observed live on the local stack 2026-05-15):

- `bash scripts/test-db.sh supabase/tests/report_run_custom.test.sql`
  → PASS (14 assertions).
- `bash scripts/test-db.sh supabase/tests/reports_anon_revoke.test.sql`
  → PASS (12 assertions).
- Direct `docker exec ... psql` probes against `report_run_custom`
  with the attack payloads documented in §Low #1 — all blocked or
  correctly sanitized.
- `select prosecdef, proconfig from pg_proc where proname = 'report_run_custom'`
  → `prosecdef = false` (SECURITY INVOKER ✓), `proconfig = {search_path=public}` ✓.
- `select set_config('request.jwt.claims', ..., false)` via the
  runner — confirmed it changes `auth.uid()` mid-session (the
  Medium #1 finding above).
- `transaction_read_only = on` flag — verified via
  `current_setting('transaction_read_only')` returns `on` inside
  the runner.
- Attempt to disable `transaction_read_only` mid-EXECUTE — fails
  with `25001 "cannot set transaction read-write mode inside a
  read-only transaction"`.
- Realtime publication membership — confirmed `report_runs` is
  NOT in `supabase_realtime` (per `20260514140000_realtime_publication_tighten.sql`).

---

### Disposition

- **Critical: 0**
- **High: 0**
- **Medium: 3** (set_config GUC mutation; pg_catalog read-through;
  user-role visibility of saved SQL — all bounded by privilege /
  per-tenant RLS / standard PostgREST request lifecycle)
- **Low: 6** (format-substitution attack surface verified safe;
  multi-statement EXECUTE behavior; `Custom SQL` allowlist
  collision risk; aggregate-over-truncation; SQL in operator log
  stream; frontend XSS surface verified absent)

Nothing here blocks merge. The Medium #1 (set_config GUC mutation)
is the only finding I would push to fix in a near-term follow-up
spec — it's the only one with a real exploit path (audit-log
attribution forgery), even though it's bounded to admin-caller
context and the next HTTP request resets the GUC.

The migration header and pgTAP test header already document both
architect-flagged deviations correctly. The spec's "Known
deviations from spec" section (spec.md:1561-1626) accurately
reflects Postgres's actual behavior. No drift to fix.
