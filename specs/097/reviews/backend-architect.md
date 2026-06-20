# Backend-architect drift review — spec 097

Mode: post-implementation drift review (READY_FOR_REVIEW). Read-only design-vs-code
comparison; no Bash; `Status:` not changed (per post-impl rules).

Design source: `specs/097-explicit-authenticated-grants-ci-durability.md` `## Backend design`
(§0 / §1a / §1b / §4 / §5 / §7).

Implementation reviewed:
- `supabase/migrations/20260618000000_public_grants_explicit.sql`
- `supabase/tests/public_grants_explicit.test.sql`
- `.github/workflows/test.yml` (Track 2 `db` job)
- `CLAUDE.md` (CI-status note, line 205)

## Verdict

**No drift. The implementation faithfully encodes the CORRECTED design across all five
checklist axes (§1a, §1b, §4, §5, contract/RLS/realtime/edge/db.ts).** Zero Critical,
zero Should-fix, zero Minor drift findings. Two non-drift observations recorded at the
bottom for completeness.

The two load-bearing source REVOKEs the corrected design hinges on were independently
verified to exist at the exact cited lines and to sort earlier than this migration:
- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:305` —
  `revoke truncate on public.profiles from authenticated, anon;` (spec-041 anti-escalation)
- `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql:68` —
  `revoke all on public.spec093_case_qty_backfill_audit from anon, authenticated;`
A repo-wide grep for any table-level `GRANT … to {anon|authenticated}` returns ONLY this
new migration — confirming no later migration re-grants TRUNCATE or routines after
`20260618000000` and undoes the posture.

---

## 1. §1a fidelity (grants on existing objects) — MATCH

Checked the corrected role-split item by item against migration lines 134–167:

| Designed (§1a) | Migration | Match |
|---|---|---|
| `grant usage on schema public to anon, authenticated, service_role` | line 134 | ✅ |
| anon/authenticated tables: `grant select, insert, update, delete, references, trigger on all tables …` (NO TRUNCATE) | lines 145–146 | ✅ exact privilege list, TRUNCATE omitted |
| service_role tables: `grant all on all tables …` | line 153 | ✅ |
| targeted audit re-lock `revoke select, insert, update, delete, references, trigger on public.spec093_case_qty_backfill_audit from anon, authenticated` **AFTER** the broad grant | lines 161–162 (emitted after line 153/146) | ✅ ordering correct — revoke wins |
| sequences: `grant all on all sequences … to anon, authenticated, service_role` | line 167 | ✅ |
| **NO** retroactive `grant all on all routines` | absent (header lines 75–88 document the deliberate omission) | ✅ correctly absent |

Order within the file matches §1a's prescription exactly: schema usage → anon/auth table
grant → service_role table grant → audit re-lock REVOKE → sequences. The re-lock REVOKE
(line 161) follows both table grants, so it is not undone. This is the single most
ordering-sensitive line in the migration and it is placed correctly.

The migration emits **exactly one REVOKE** (the audit re-lock), as §1c requires. The
`profiles` TRUNCATE lock is preserved structurally — by omitting TRUNCATE from the broad
anon/authenticated grant at the source (line 145) — not by a REVOKE. This is the corrected
design's central move and it is implemented precisely.

## 2. §1b fidelity (default privileges for future objects) — MATCH

Checked against migration lines 187–204:

| Designed (§1b) | Migration | Match |
|---|---|---|
| `alter default privileges for role postgres in schema public` on every statement | lines 187, 192, 196, 203 all carry `for role postgres` | ✅ the load-bearing ownership call is present on all four |
| future tables anon/authenticated: same no-TRUNCATE list | lines 187–189 | ✅ |
| future tables service_role: `grant all on tables` | lines 192–193 | ✅ |
| future sequences: `grant all on sequences` to all three | lines 196–197 | ✅ |
| future functions: `grant all on functions` to all three (object-class keyword `functions`, not `routines`) | lines 203–204 | ✅ correct grammar |

`FOR ROLE postgres` is present on all four `ALTER DEFAULT PRIVILEGES` statements — the
design called this REQUIRED (finding #4: migrations run as `postgres`, so only postgres's
default privileges govern future-object inheritance). No bare ALTER. No drift.

## 3. §4 fidelity (the pgTAP probe) — MATCH

`plan(10)` declared at line 148; counted the `ok/is` calls in the file:
arm(1)=1, arm(2)=1, arm(3)=1, arm(4)=1, arm(5)=3 (5a/5b/5c), arm(6)=3 (6a/6b/6c) = **10**.
Plan count equals authored assertions, satisfying §4d's "planned N but ran M" discipline.

Arm-by-arm against the designed assertion set:

- **Arms 1–2 (positive iterate-all):** cross-join `pg_tables` × {anon, authenticated,
  service_role}, flag `not has_table_privilege(role, format('%I.%I', …), 'SELECT')`, subtract
  the role-keyed allowlist; arm 1 asserts count = 0, arm 2 asserts `string_agg` = '' for
  log-readability. Matches §4a/§4c arms 1–2. ✅
- **Arm 3 (synthetic regression / missing-grant guard):** creates `__grant_probe_negative_test`,
  `revoke select … from authenticated`, captures hit count via `set_config`, **drops the
  synthetic table, THEN asserts** count = 1. Drop-then-assert pattern is used (lines 274–304),
  avoiding the savepoint+rollback counter-loss footgun §4c flags. ✅
- **Arm 4 (false-positive guard):** second synthetic table left with inherited grant intact,
  asserts detector flags 0 — incidentally proving the §1b default-privileges inheritance fired.
  Matches §4c arm 4. ✅
- **Arm 5 (negative — profiles.TRUNCATE):** 5a `not has_table_privilege('authenticated',
  'public.profiles','TRUNCATE')`, 5b same for `anon`, 5c `has_table_privilege('service_role',
  …,'TRUNCATE')` true. This is the designated "would-have-caught-the-flaw" arm. Messages cite
  `20260517040000:305` + §1a. Matches §4a/§4c arm 5. ✅
- **Arm 6 (negative — audit table SELECT):** 6a/6b assert SELECT false for authenticated/anon,
  6c asserts SELECT true for service_role. Messages cite `20260602120000:68` + §1a re-lock.
  Matches §4a/§4c arm 6. ✅
- **Allowlist:** a **1-row role-keyed** `VALUES` list keyed `(schemaname, tablename, rolename)`
  seeding `('public','spec093_case_qty_backfill_audit','anon')` and `(…,'authenticated')` ONLY
  (lines 188–195, 233–236). The `service_role` pair is deliberately NOT listed, so arm 1/2 still
  assert SELECT-true on the audit table for service_role. This is Category A handled exactly as
  §4b prescribes. ✅
- **Category B off the allowlist:** `username_resolve_rate_limit` and `_edge_auth` appear
  nowhere in the allowlist VALUES — they are subject to the positive sentinel (the probe asserts
  they HOLD the grant), correct per §4b Category B. Header lines 80–92 document the rationale.
  ✅

The probe asserts TABLE privileges only — no routine EXECUTE assertion for anon/authenticated
(which would contradict §1.2 / the ~15 EXECUTE REVOKEs). Probe and migration stay aligned on
both faces of the hazard. ✅

## 4. Contract / RLS / realtime / edge / db.ts drift — MATCH (all N/A)

- **RLS:** the migration contains zero `CREATE/ALTER/DROP POLICY` and zero `ENABLE/DISABLE ROW
  LEVEL SECURITY`. Grant layer only. ✅ (design §2)
- **Realtime:** no `supabase_realtime` / `alter publication` statement. The
  `docker restart supabase_realtime_imr-inventory` ritual does not apply. ✅ (design §3)
- **Edge functions:** `supabase/config.toml` not in the change set; no `verify_jwt` / service-token
  change. ✅
- **`src/lib/db.ts` / `src/store/useStore.ts`:** untouched — this is backend + CI only, no client
  surface, no new helper, no snake_case→camelCase mapping. ✅
- **Additive / no down migration:** migration body is GRANT + ALTER DEFAULT PRIVILEGES + one
  targeted REVOKE; no `DROP`, no down file. Strictly additive. ✅ (design §1)

## 5. §5 fidelity (CI pin) — MATCH

`.github/workflows/test.yml` Track 2 `db` job: `version: 2.106.0` (line 139), a **fixed** pin —
not `latest`, not a floating `>=`. The comment block (lines 127–138) is coherent and non-stale:
it states 2.106.0 is the first CLI family that revokes the implicit grants, names
`20260618000000_public_grants_explicit.sql` as the durable fix, explains the deliberate forward
move, and explains why fixed-not-`latest`. Matches §5's recommendation and AC line 98–114. The
other three jobs (jest, typecheck, typecheck-base) are untouched. ✅

`CLAUDE.md` line 205: a single-line parenthetical inside the existing "CI status check" note,
pointing at the spec-097 migration by name as the durable fix for the CLI-grant-drift class of
the local-green/CI-red asymmetry. Additive, accurate, filename correct. Matches §8. ✅

---

## Non-drift observations (NOT findings — recorded for the release-coordinator)

1. **Prod reconciliation + the 2.106.0 Track-2-on-main green are pending by design.** The
   spec's Files-changed "Pending by design" block and §6 both correctly classify these as
   post-merge release steps, not code-authoring steps. The local validation note explains the
   local image (`postgres:17.6.1.084`) still grants ALL by default, so several grant lines are
   local no-ops and the definitive proof is the post-push Track 2 run against 2.106.0. This is
   the load-bearing AC (line 104–109) and remains OPEN until that green run on `main` is
   confirmed — flagged for release-coordinator, consistent with the prompt's instruction that
   this is not drift.

2. **Work is staged, not committed** — per project policy (stage-and-report). Consistent with
   expectations; not a drift concern.

## Files cited
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260618000000_public_grants_explicit.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/public_grants_explicit.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml` (lines 124–139)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md` (line 205)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql` (line 305 — source REVOKE)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260602120000_spec093_case_qty_backfill.sql` (line 68 — source REVOKE)
