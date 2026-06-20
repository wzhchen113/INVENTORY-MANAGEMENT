-- ============================================================
-- Spec 097 — make the default Supabase-role grants on public.* EXPLICIT.
--
-- THE GAP
-- -------
-- Track 2 ("Supabase DB tests") in .github/workflows/test.yml ran
-- `supabase/setup-cli@v1` with `version: latest`. That floated from CLI
-- 2.105.0 (live at the last green DB-test run, 2026-06-08) to 2.106.0+, whose
-- bundled Postgres image REVOKES the implicit broad
-- `GRANT ... ON public.* TO {anon, authenticated, service_role}` that older
-- images granted by default. Our pgTAP tests run as the `authenticated` role
-- (they exercise RLS via auth.uid() JWT-claim injection), so without
-- table-level grants they cannot even reach the RLS check — 34 of 46 files
-- failed with `permission denied for table ... (SQLSTATE 42501)`. Local dev
-- stayed green only because it reuses the OLD cached image (postgres:17.6.1.084)
-- that still carries the implicit grants. This is the documented
-- local-green/CI-red pgTAP asymmetry (CLAUDE.md; specs 060/067).
--
-- Nothing in the repo restored those grants: a grep over every migration EARLIER
-- than this one (< 20260618000000) for `grant ... to {anon|authenticated}` on a
-- public table returns ZERO matches (this migration's own grants below are the
-- first such entries),
-- and seed.sql carries no GRANT/REVOKE/ROLE setup. Every table grant those two
-- roles enjoyed on public.* came purely from the image default — so when the
-- image stopped emitting it, the grant vanished. THIS migration is the first
-- and only place those grants become schema-explicit.
--
-- THE FIDELITY BAR IS THE *NET-EFFECTIVE* POSTURE, NOT THE RAW IMAGE DEFAULT
-- -------------------------------------------------------------------------
-- "Restore the pre-2.106 default posture" must mean the NET-EFFECTIVE grant
-- ACL the project actually had immediately pre-2.106 = the raw image default
-- MINUS the two deliberate table-level REVOKEs the project had already layered
-- on top of it. Restoring the raw `GRANT ALL` verbatim would RE-OPEN two holes
-- the project deliberately closed:
--
--   1. supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:305
--      `revoke truncate on public.profiles from authenticated, anon;` — the
--      spec-041 round-3 live-verified Critical anti-escalation fix (a brand-admin
--      TRUNCATEs public.profiles to bypass the row-level UPDATE/DELETE triggers,
--      then re-INSERTs as a cross-brand super_admin). `GRANT ALL` includes
--      TRUNCATE, so a blanket grant re-arms the escalation. Guarded by
--      auth_can_see_store_brand_scope.test.sql arm 14 + profiles_rls_sweep.test.sql
--      arm 12.
--   2. supabase/migrations/20260602120000_spec093_case_qty_backfill.sql:68
--      `revoke all on public.spec093_case_qty_backfill_audit from anon,
--      authenticated;` — a back-office audit table deliberately locked at the
--      grant layer. `GRANT ALL ON ALL TABLES` silently re-grants SELECT/everything
--      on it.
--
-- So this migration reproduces the net-effective ACL (image default MINUS those
-- two REVOKEs), NOT the raw default. It is still "the full client-usable set",
-- not a hand-picked SELECT-only subset.
--
-- WHAT THIS MIGRATION DOES (approach 7a, corrected)
-- ---------------------------------------------------------------------------
--   1. Retroactive grants on EXISTING objects — TABLES + SEQUENCES + schema
--      USAGE only — split by role so both deliberate REVOKEs survive:
--        - anon/authenticated tables: an explicit privilege list that OMITS
--          TRUNCATE (select, insert, update, delete, references, trigger). This
--          preserves the spec-041 `profiles` TRUNCATE revoke AT THE SOURCE — the
--          grant can never re-open it, regardless of migration ordering — and
--          hardens the whole TRUNCATE-escalation class for every table.
--        - service_role tables: full `GRANT ALL` (it has ZERO table-level
--          REVOKEs anywhere and legitimately retains TRUNCATE per the spec-041
--          comment "service_role retains TRUNCATE (separate grant audience)").
--        - then ONE targeted `revoke ... from anon, authenticated` on
--          spec093_case_qty_backfill_audit AFTER the broad table grant, to
--          restore its deliberate spec-093 lock that the broad grant just undid.
--        - sequences: `GRANT ALL` to all three (no per-sequence REVOKE exists).
--   2. ALTER DEFAULT PRIVILEGES FOR ROLE postgres so every FUTURE object created
--      in public inherits the appropriate grant automatically (the same
--      no-TRUNCATE split for tables; ALL for sequences + functions). This
--      future-object half is what makes the fix DURABLE: a later CLI bump can
--      never re-strand a newly-added table, and a future table is born with the
--      no-TRUNCATE baseline so the escalation class is closed by construction.
--
-- WHY NO RETROACTIVE `GRANT ... ON ALL ROUTINES` (the one subtlety)
-- ----------------------------------------------------------------
-- ~15 earlier migrations do `REVOKE EXECUTE ... FROM public, anon, authenticated`
-- on specific SECURITY DEFINER RPCs as defense-in-depth (specs 016/061/095:
-- staff RPCs, report RPCs, check_username_resolve_rate_limit, etc.). A blanket
-- `grant all on all routines in schema public` at this timestamp (20260618000000)
-- would sort AFTER all of those REVOKEs and RE-OPEN execute on the
-- deliberately-locked RPCs — a security regression. The 34 failing files all
-- failed on TABLE `permission denied`, never on function EXECUTE (functions were
-- already correctly granted/revoked by their own migrations), so a retroactive
-- routines grant solves no observed failure and actively risks re-opening locked
-- RPCs. Routines are therefore restored for FUTURE objects ONLY, via the
-- ALTER DEFAULT PRIVILEGES ... ON functions line below. Existing functions keep
-- exactly what their own migrations granted/revoked.
--
-- IDEMPOTENCY & PROD SAFETY
-- -------------------------
-- `GRANT`, `ALTER DEFAULT PRIVILEGES ... GRANT`, and the single targeted re-lock
-- `REVOKE` are all idempotent by definition — re-applying is a harmless re-grant
-- / re-revoke / no-op. Prod predates the image change and still carries the
-- implicit grants AND both deliberate REVOKEs (spec-041's profiles TRUNCATE
-- revoke and spec-093's audit-table revoke are already applied there). This
-- migration reproduces exactly that net-effective ACL:
--   - the no-TRUNCATE table grant for anon/authenticated is a SUBSET of what prod
--     already holds, so re-granting SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER
--     changes nothing;
--   - the service_role `GRANT ALL` re-grants what it already holds;
--   - the audit-table re-lock REVOKE removes a grant the audit table never had on
--     prod (spec 093 already revoked it), so it is a no-op;
--   - the ALTER DEFAULT PRIVILEGES rows are added to prod's catalog harmlessly.
-- NET EFFECT ON PROD: nil — a safe no-op. The migration contains exactly ONE
-- `REVOKE` (the targeted audit-table re-lock); it does NOT touch the per-RPC
-- EXECUTE-REVOKE hardening (those live in their own migrations and remain in
-- force). The profiles TRUNCATE lock is preserved not by a REVOKE here but by
-- OMITTING TRUNCATE from the broad grant (at the source). Strictly additive; no
-- down migration (repo convention).
--
-- RLS: zero policy change. Restoring the broad table grant does NOT make any
-- RLS-on table reachable that wasn't before — username_resolve_rate_limit and
-- _edge_auth stay locked to anon/authenticated via their (absent permissive) RLS
-- policies. The grant is the OUTER gate; RLS is the INNER gate; both must pass.
--
-- REALTIME: no supabase_realtime publication change. The
-- `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
--
-- ORDERING: 20260618000000 sorts AFTER every existing migration (latest on disk
-- is 20260607130000_username_resolve_rate_limit.sql). Both RLS-locked tables and
-- the audit table already exist when this runs, so the broad TABLE grant picks
-- them up — which is exactly why the audit-table re-lock REVOKE must follow it.
-- ============================================================


-- ─── Part 1: grants on EXISTING objects (tables + sequences + usage) ───
-- Order within this part: schema usage first (required before any object inside
-- the schema is reachable); then the anon/authenticated table grant; then the
-- service_role table grant; then the audit-table re-lock REVOKE (MUST follow the
-- table grants); then the sequences grant. NO retroactive routines grant — see
-- header.

grant usage on schema public to anon, authenticated, service_role;

-- Tables (+ views) — anon/authenticated: explicit privilege list that OMITS
-- TRUNCATE. PostgREST/clients never need TRUNCATE; dropping it from the broad
-- grant preserves the spec-041 `revoke truncate on public.profiles from
-- authenticated, anon` AT THE SOURCE (this grant can never re-open it, regardless
-- of migration ordering). This is the net-effective pre-2.106 posture for these
-- two roles, not the raw image default. RLS remains the real per-row gate; this
-- list does not weaken any per-row check. ALL TABLES covers PostgREST-exposed
-- views too (they inherit table-class grants; views have no TRUNCATE concept, so
-- omitting it is a no-op for views).
grant select, insert, update, delete, references, trigger
  on all tables in schema public to anon, authenticated;

-- Tables (+ views) — service_role: full ALL. service_role legitimately RETAINS
-- TRUNCATE (the spec-041 revoke deliberately scoped only anon/authenticated; its
-- migration comment notes "service_role retains TRUNCATE (separate grant
-- audience)") and has ZERO table-level REVOKEs anywhere, so the raw broad grant
-- is faithful for this role and re-opens nothing.
grant all on all tables in schema public to service_role;

-- EXCLUSION — re-lock the one audit table that spec 093 deliberately
-- `revoke all ... from anon, authenticated`. The anon/authenticated table grant
-- above just re-granted SELECT/etc on it; restore its deliberate lock. Emit this
-- AFTER the broad table grant so it wins. service_role keeps its grant (it
-- predates and is unaffected). This is the ONE table that withholds the grant by
-- design (Category A — see the probe's allowlist).
revoke select, insert, update, delete, references, trigger
  on public.spec093_case_qty_backfill_audit from anon, authenticated;

-- Sequences: `GRANT ALL ON SEQUENCE` expands to USAGE + SELECT + UPDATE; emit
-- ALL for fidelity to the default posture. No competing per-sequence REVOKE
-- exists (grep-confirmed). All three roles.
grant all on all sequences in schema public to anon, authenticated, service_role;


-- ─── Part 2: default privileges for FUTURE objects ────────────────────
-- FOR ROLE postgres is explicit-by-design: migrations run as postgres, so every
-- future table/sequence/function created by a later migration is postgres-owned,
-- and only postgres's default privileges govern their inheritance. Stating
-- FOR ROLE postgres makes this correct regardless of which role the apply
-- session reports as current_user, and self-documents the ownership assumption.
--
-- NOTE the grammar quirk: the object-class keyword is `functions` in the
-- ALTER DEFAULT PRIVILEGES form (the `routines` spelling is only valid in the
-- `GRANT ... ON ALL ROUTINES` form). Including functions here is SAFE — default
-- privileges affect only FUTURE objects, never the existing hardened RPCs.

-- Future tables — anon/authenticated: same no-TRUNCATE privilege list as Part 1,
-- so a future table inherits everything-except-TRUNCATE and the escalation class
-- can never be reintroduced by accident. A future table that genuinely needs
-- anon/authenticated TRUNCATE revoked could still do it explicitly (as profiles
-- did); defaulting to no-TRUNCATE is the safer baseline.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete, references, trigger
  on tables to anon, authenticated;

-- Future tables — service_role: ALL (retains TRUNCATE, matching Part 1).
alter default privileges for role postgres in schema public
  grant all on tables to service_role;

-- Future sequences: ALL to all three (no competing per-sequence REVOKE class).
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Future functions: ALL (= EXECUTE) to all three. This is the ONLY routine
-- restoration in the migration (no retroactive routines grant — see header /
-- §7 risk 1.2). A future RPC that must be locked down emits its own
-- `REVOKE EXECUTE` explicitly, as the ~15 existing hardening migrations do.
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
