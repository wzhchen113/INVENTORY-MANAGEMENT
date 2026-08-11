# Spec 157 — architectural drift review (backend-architect, post-implementation)

Reviewer: backend-architect, post-impl mode. Spec `Status: READY_FOR_REVIEW` on
entry; **not** modified by this review.

Artifacts read in full:

- `specs/157-super-admin-rls-parity.md` (PM half, my design, backend-developer's
  report, both D-0 execution records)
- `supabase/migrations/20260809000000_super_admin_policy_parity.sql`
- `supabase/tests/super_admin_policy_parity.test.sql`
- `src/screens/DBInspectorScreen.tsx`
- `src/screens/__tests__/DBInspectorScreen.test.tsx`
- Corroborating: `20260504173035_per_store_rls_hardening.sql:154-181`,
  `20260517020000_admin_rpcs_use_privileged.sql:14-135`,
  `20260507015244_spec004_ingredient_categories_rls_p6.sql`,
  `20260405000759_init_schema.sql:278` + `20260502071736_remote_schema.sql:7`,
  `supabase/tests/permissive_policy_lint.test.sql`,
  `supabase/tests/admin_rpcs_privileged.test.sql`,
  `.github/workflows/db-migrations-applied.yml:40-49`, `src/lib/db.ts` (grep only)

**Verdict: no Critical findings. The implementation matches the design contract.**
2 Should-fix (both documentation/process, neither in the shipped code), 7 Minor.

---

## Contract conformance — what I checked and what held

| design clause | result |
|---|---|
| Exactly 7 policies rewritten, wrapper `auth_is_privileged()` called (not longhand `auth_is_admin() OR auth_is_super_admin()`) | ✔ migration:175-247 |
| Policy names byte-verbatim incl. quoted-identifier spelling | ✔ all seven |
| `store_id is not null and auth_can_see_store(store_id)` OR-arms byte-unchanged | ✔ diffed against `20260504173035:160-172` — identical apart from the helper |
| `permissive` kind / `to` role list unchanged (no `to` clause on any of the seven, matching `{public}`) | ✔ |
| `auth_is_admin()` body untouched (AC-5 / AC-REG-2) | ✔ only `comment on function` at migration:254-268 |
| Probe body copied verbatim, delta = 2 additive `auth` keys | ✔ line-by-line against `20260517020000:14-135`; `schema` / `counts` / `recipe_groups` / `prep_groups` identical, guard / `security definer` / `set search_path` / signature identical, grants not re-issued |
| `begin; … commit;` wrapper (R-3) | ✔ migration:166, 407 |
| Spec-051-shaped header + operational rollback block reproducing the 7 pre-change statements | ✔ migration:1-164 |
| No table/column/index/trigger/grant/publication change; no realtime ritual added | ✔ |
| pgTAP `plan(20)`, 20 arms, F-1/IC-1…8/AL-1…10/LINT-1 | ✔ counted 20 assertions; matches `plan(20)` at test:69 |
| LINT-1 scans `pg_policies` only, never `pg_proc` | ✔ test:405-424 |
| `__test_spec157_*` collision-proof fixtures | ✔ |
| Classifier rule order 1→5 exactly as designed | ✔ `DBInspectorScreen.tsx:168-174` |
| `is_privileged` / `is_super_admin` optional on the client (AC-15) | ✔ `DBInspectorScreen.tsx:78-84` |
| Banner copy constraints (no `ALL your CRUD`, no `You are NOT admin per the JWT`, `auth_is_admin` only in the super-admin branch) | ✔ verified by reading the whole file, and pinned by jest arms at `DBInspectorScreen.test.tsx:146-162` |
| `src/lib/db.ts` out of the diff (OQ-4 ruling) | ✔ grep finds only three pre-existing *comment* references to `auth_is_privileged`; no code change |
| No new `supabase.from(...)` in the screen; the pre-existing `supabase.rpc` carve-out not widened | ✔ `DBInspectorScreen.tsx:230, 522` are the pre-existing calls |
| No i18n surface added (AC-14), legacy `useColors()` retained | ✔ |

Two places where the implementation is **better than the design**, and I want that
on the record rather than buried:

1. **IC-3 (`test:172-179`)** targets `name in (pre, post)` and asserts on both.
   The developer's negative-control pass found that the original single-name form
   passed trivially whenever IC-2's rename had been denied. That is exactly the
   false-pass class my §9 warned about for AL-7/AL-8 and I did not anticipate it
   for IC-3. Good catch.
2. **AL-7 / AL-8 (`test:292-312`)** assert on the row's surviving `detail` value
   rather than a row count. This makes the arm self-verifying on *visibility* too:
   if the plain user could not SELECT the row, the scalar subquery yields `NULL`
   and the arm fails. My design asked for "affects 0 rows", which would have
   passed vacuously if the seed's `user_stores` grant on Towson ever changed.

I also independently confirmed the AL-7/AL-8 premise is not undermined by a
leftover wide policy: the init-schema `create policy "Store access" on audit_log
for all using (store_id in (select … user_stores …))`
(`20260405000759_init_schema.sql:278`) was dropped in
`20260502071736_remote_schema.sql:7`. `audit_log` carries exactly the four
policies this migration rewrites — so the plain user's UPDATE/DELETE is refused
by `admin_update/delete_audit_log` and nothing else, which is what AL-7/AL-8
claim to prove.

---

## Rulings on the five questions in the dispatch

### 1. Corrected query (b) — `prokind = 'f'` vs my original — ACCEPTED, my original was wrong

`pg_get_functiondef()` raises on aggregate and window entries, and the planner is
free to evaluate it before the `nspname = 'public'` join qualifier, so the query
as written in the PM section and repeated in my §0 **cannot run** on a schema that
has any aggregate in `public`. The `array_agg is an aggregate function` error the
developer hit (`spec:820`) is the correct diagnosis and `and p.prokind = 'f'` is
the correct minimal fix. The corrected form is what was run against prod and is
the form that should live in the spec.

This does not weaken D-0: the stop-and-escalate condition was never query (b)'s
row list, it was the sharper gate-only probe
(`~* 'not\s+public\.auth_is_admin\s*\(\s*\)'`), which returned **0 rows locally
and 0 rows on prod**. That is the assertion that mattered and it is satisfied.

Residual, filed as M-1 below: `prokind = 'f'` also excludes procedures
(`prokind = 'p'`), which `pg_get_functiondef` handles fine. There are zero
`CREATE PROCEDURE` statements under `supabase/` today, so there is no coverage
gap now.

### 2. Four-rows-not-three — ACCEPTED, my prediction was wrong

My §0 predicted three rows for query (b) and omitted `auth_is_admin()` itself,
whose own `CREATE OR REPLACE FUNCTION public.auth_is_admin()` header trivially
contains its own name under a `like '%auth_is_admin%'` match. The developer's
"four, and here is why each one is not a gate" is correct, and prod returned the
same four (`spec:1632`). None of the four is a gate:

- `auth_is_admin()` — self-match
- `auth_can_see_store(uuid)` — documented OR-arm, no-op for super_admin (short-circuits on `auth_is_super_admin()` first)
- `auth_is_privileged()` — documented OR-arm
- `admin_db_inspector_probe()` — payload emit, intentionally KEPT per AC-11

The blast-radius claim in the spec therefore survives prod verification unchanged:
**7 policies, 0 function gates.** AC-REG-1's "exactly seven rows differ" holds on
prod, not just on the migration chain. D-0 is properly satisfied and I consider
R-1 (my §11 Critical-class risk) **closed**.

### 3. Ionicons-union deviation in `AUTH_BANNER_COPY` — ACCEPTED; the design was at fault

My §8 wrote `icon: string; // Ionicons name`. That is a design bug. `AUTH_BANNER_COPY[state].icon`
is passed straight into `<Ionicons name={authBanner.icon} …>` at
`DBInspectorScreen.tsx:290`, and `Ionicons`' `name` prop is a literal union over
the glyph map — `string` is not assignable to it, so the design as written would
have failed `tsc --noEmit` and invited an `as any` at the render site, which is
precisely the pattern this codebase should not accumulate.

The implementation's local
`type IoniconName = React.ComponentProps<typeof Ionicons>['name']`
(`DBInspectorScreen.tsx:143`) is the correct derivation — it tracks the installed
`@expo/vector-icons` version rather than hardcoding a union, and it makes the
three chosen glyphs (`shield-checkmark`, `warning`, `help-circle`) compiler-checked.
**Not drift. Strictly better than the design.** Filed only as M-6 (a cosmetic
export-visibility note).

### 4. Deploy-ordering (DB before web) in §10 — ADEQUATE FOR CORRECTNESS, IMPRECISE OPERATIONALLY (Should-fix S-2)

§10 step 5 states the ordering and states correctly that it is not load-bearing:
the AC-15 `unknown` state means a new bundle against an old DB degrades to a
neutral banner, never a false green. I re-verified that claim against the shipped
classifier (`DBInspectorScreen.tsx:170` — `typeof auth.is_privileged !== 'boolean'`
returns `'unknown'` *before* any `is_admin` fallback) and against jest arm 4
(`DBInspectorScreen.test.tsx:111-119`). The safety property is real.

What §10 does not say, and should: **step 5 is not an operator-scheduled step.**
If the Vercel git integration is deploying `main` on push (the default, and
`vercel.json` carries only the build command — the trigger is a project setting,
not repo state), then the web bundle ships at **step 1**, not step 5. The true
sequence is web-first, and the merge→apply window has two observable properties
an operator should be told about up front:

- a `super_admin` opening DB Inspector in that window sees the **neutral
  `unknown` banner** (correct, by design — not a symptom);
- the RLS bug is **still live** in that window, so the step-6 owner smoke
  (add/rename/delete an ingredient category) will still silently fail if run
  before step 2 completes.

One sentence in §10 fixes both. No code change.

### 5. CLI 2.113-vs-2.108 — NO RUNBOOK LANGUAGE REQUIRED for this spec (Minor M-3)

The pin at `.github/workflows/db-migrations-applied.yml:49` exists solely because
the gate `awk -F'|'` parses `supabase migration list --linked` table output, and
v2.109.0's Go→TS port changed that table. Nothing in spec 157's apply path touches
the CLI: §10 step 2 is Supabase MCP `execute_sql` + a manual `schema_migrations`
insert (the house substitute for `db push`, which lacks the prod password). The
developer's local `npx supabase migration up --local` at 2.113.x exercises the
migration-apply path, not the fragile `migration list` parser, so a 2.113 local
CLI is not a risk to this change and not a reason to touch the pin.

§10 step 4 already carries the important half — *"a red gate is not automatically
drift — diff repo migrations against `schema_migrations` first."* The only thing
worth adding is one clause noting that `package.json` has **no `supabase`
devDependency**, so `npx supabase` locally resolves to latest (2.113.x today)
while CI is pinned to 2.108.0 — i.e. an operator reproducing the gate's command
locally to diagnose a red run is running a *different* CLI with a *different*
table format. That is the trap the pin comment is about, one hop removed.
Optional; not blocking.

---

## Findings

### Critical

None.

### Should-fix

**S-1 — the spec's `## Files changed` omits the frontend half; the "Still owed"
list is stale.**
`specs/157-super-admin-rls-parity.md:1537-1541` scopes the section to "Backend
half only" and `:1618-1625` still lists *"3. The frontend half —
frontend-developer"* as owed. Both frontend artifacts exist on disk and are in
this review's scope:

- `src/screens/DBInspectorScreen.tsx` (modified — `ProbeAuth`,
  `classifyAuthBanner`, `AUTH_BANNER_COPY`, banner render, `fmtFlag` kvLine)
- `src/screens/__tests__/DBInspectorScreen.test.tsx` (new, 10 `it` blocks
  covering the 6 designed arms)

`release-coordinator` reads this section to build the ship proposal, and the
CLAUDE.md pipeline contract says the implementing agent appends its own entry.
As written, the proposal would under-report the diff and would carry a stale
blocker. Also stale in the same list: item 1 ("the prod half of D-0") — the D-0
prod execution record at `:1627-1636` closes it and says **SATISFIED**. Items 2
(prod apply) and 4 (CLAUDE.md bullet decision) remain genuinely owed.
**Fix: append the frontend entry to `## Files changed` and prune items 1 and 3
from "Still owed".** Documentation only.

**S-2 — §10 does not say that the web deploy is not operator-scheduled.**
Detail and proposed sentence under ruling 4 above. `specs/…:1420-1425`.
Documentation only; the shipped `unknown` state already makes the ordering safe.

### Minor

**M-1 — `prokind = 'f'` is one character too narrow for the recorded D-0 query.**
It excludes procedures (`prokind = 'p'`), for which `pg_get_functiondef` works.
Zero `CREATE PROCEDURE` under `supabase/` today, so no gap now. If the query text
is going to live in the spec as the canonical D-0 probe (it should), prefer
`p.prokind in ('f','p')` in both the payload query and the gate-only regex probe.

**M-2 — record that query (b) stays at 4 rows after the apply.**
§10 step 3 correctly re-runs only query (a) (expect 0). Someone re-running (b)
post-apply will still get 4 — `admin_db_inspector_probe()` deliberately keeps
emitting `is_admin` per AC-11, and `auth_is_admin()` still self-matches. Worth one
line so a future operator does not read 4 as a failed apply.

**M-3 — optional CLI clause in §10 step 4.** See ruling 5.

**M-4 — R-5 (retention-purge cost) can be closed as a non-issue, not carried
forward.** `admin_update_audit_log` / `admin_delete_audit_log` now read
`using (public.auth_is_privileged())` — a **var-free** qual. Postgres classifies
var-free quals as one-time filters, so `auth_is_super_admin()`'s `profiles` PK
probe is evaluated **once per statement**, not once per row, on
`cleanupOldRecords`' global delete. The mixed predicate on
`store_member_read_audit_log` does evaluate per row for `store_id IS NULL` rows,
but prod `audit_log` is 4,485 rows total (`spec:1634`). No measurable cost, and
`admin`/`master` callers short-circuit on the first OR arm and pay nothing.
Recommend downgrading R-5 from an open risk to a resolved note.

**M-5 — 4 `comment on policy` where the design asked for 2.** Design §3 required
comments only on `admin_update_audit_log` / `admin_delete_audit_log` (the OQ-3
deferred-gap annotation); the migration also comments
`store_member_read_audit_log` / `store_member_insert_audit_log`
(`migration:184-197`). Purely additive metadata, does not appear in `pg_policies`,
does not affect AC-REG-1's seven-row diff. Approved as-is, no action.

**M-6 — `IoniconName` is not exported but is referenced by the exported
`AUTH_BANNER_COPY` type.** Harmless under `--noEmit` (both typecheck jobs are
clean per the developer's report) and `tsconfig.json` sets no `declaration`. It
would surface as TS4023 only if declaration emit were ever enabled. Exporting the
alias costs nothing if anyone wants to pre-empt that.

**M-7 — consider promoting the gate-only function-body probe into a second lint
arm.** LINT-1 (`test:405-424`) correctly scans `pg_policies` only — a `pg_proc`
scan would false-fail on `auth_can_see_store()`, `auth_is_privileged()` and the
probe RPC, exactly as my §9 required. But the *gate-specific* regex
(`~* 'not\s+public\.auth_is_admin\s*\(\s*\)'`, with the M-1 `prokind` filter) has
no such false-positive surface and is provably `= 0` on both local and prod
today. Adding it as LINT-2 would convert a one-shot D-0 check into a standing CI
guard against someone reintroducing an `if not public.auth_is_admin()` guard in a
new SECURITY DEFINER RPC — the failure mode `20260517020000` had to clean up once
already. Out of the current design's scope; a cheap follow-up (`plan(21)`).

---

## Deliberate exclusions — re-affirmed, no drift

`src/lib/db.ts` untouched (OQ-4 / FUTURE-2), `audit_log` UPDATE/DELETE left
unscoped by store (OQ-3 / FUTURE-1, now annotated in-database at
`migration:206-216`), no edge function or `supabase/config.toml` change
(AC-REG-6), no `src/screens/staff/**` or i18n change (AC-REG-5 / AC-14),
`app.json` untouched with `slug: towson-inventory` intact (AC-REG-7), no
`supabase_realtime` publication change and no `docker restart
supabase_realtime_imr-inventory` step added anywhere (AC-REG-8 — and neither
table is a publication member in the first place), and
`supabase/tests/permissive_policy_lint.test.sql` unmodified with no allowlist row
added (AC-8 — `auth_is_privileged()` is a function call, outside that probe's
trivially-wide token set, and the file itself names it as a *scoped* predicate at
`:137`).

## Gates still owed before ship (unchanged by this review)

1. Prod apply per §10 step 2 (MCP `execute_sql` + exact `20260809000000` row in
   `supabase_migrations.schema_migrations` + normalized-md5 verification of both
   touched functions).
2. Post-apply re-run of query (a) → expect 0 rows.
3. Both CI gates green on `main` **after** the apply — `test.yml` and
   `db-migrations-applied.yml`. The gate is expected red in the merge→apply
   window; that is the known window, not drift.
4. Owner decision on the OQ-5 CLAUDE.md bullet (agents do not edit CLAUDE.md
   unilaterally).

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 9 findings by severity — 0 Critical,
  2 Should-fix (both documentation: the spec's `## Files changed` omits the
  frontend half and carries a stale "still owed" list; §10's deploy-ordering step
  does not say the Vercel web deploy fires at merge rather than as an operator
  step), 7 Minor. All five dispatch questions ruled on: the `prokind='f'`
  correction and the four-rows expectation are both accepted as corrections to my
  design, the Ionicons-union deviation is accepted and is better than the design's
  `icon: string`, deploy ordering is correct-but-imprecise, and the CLI 2.113 note
  needs no runbook change because the apply path is MCP rather than the CLI.
payload_paths:
  - specs/157-super-admin-rls-parity/reviews/backend-architect.md
