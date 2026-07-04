# Security audit for spec 110 — named, store-shared weekly-count layouts

Auditor: security-auditor. Scope: auth / authz / secrets / input-validation /
dependencies for the spec-110 change set. Method: read the migration + spec +
frontend/db.ts/staff carve-out, then **probed the live local stack**
(`supabase_db_imr-inventory`, migration applied + recorded in
`schema_migrations`) with simulated JWT claims for the two seed fixtures
(admin `11111111…`, staff-role manager `22222222…`). Every load-bearing claim
below was exercised against the running database, not inferred from SQL.

**Verdict: no Critical findings. Ships from a security standpoint.** One
Should-fix (a low-severity existence oracle in two RPCs) and two grant-posture
Nits (both pre-existing project-wide defaults, not spec-110 regressions). None
block; the Should-fix is a defense-in-depth hardening the release-coordinator
may choose to defer.

---

## Live verification of the 8 load-bearing claims

| # | Claim | Live result |
|---|-------|-------------|
| 1 | AC-3b server-side write gate | **PASS** — staff SELECT allowed; staff RPC save → `42501`; staff direct INSERT → RLS WITH CHECK `42501`; staff direct UPDATE/DELETE → 0 rows. |
| 2 | Non-member isolation | **PASS for reads** (0 rows, no leak on qualified or unqualified SELECT); **partial for RPC error surface** — see Should-fix SF-1 (rename/delete leak a bare existence oracle). |
| 3 | 3-per-store cap cannot be bypassed | **PASS** — 4th RPC create → `P0001 'layout limit reached'`; direct `position=4` → `23514` CHECK; duplicate slot → `23505` unique. |
| 4 | Privilege model matches CLAUDE.md | **PASS** — RPC gate and all three write RLS policies use `auth_is_privileged()` + `auth_can_see_store()`; no drift between RPC and RLS predicates. |
| 5 | Grants + permissive lint | **PASS on lint** (4/4 arms green, no allowlist edit); two grant Nits (N-1, N-2) that are project-wide defaults, not spec-110-introduced. |
| 6 | Input validation / no injection / no created_by spoof | **PASS** — no dynamic SQL, name+item_ids CHECKs enforced, `created_by` bound to `auth.uid()` server-side (RPC has no such param). |
| 7 | AC-13 cleanup DELETE bounded | **PASS** — `WHERE screen IN ('admin-inventory','staff-weekly')`; EOD tokens untouched; pgTAP arm (27) pins it. |
| 8 | Frontend has no hidden write path / cap is UX-only | **PASS** — staff carve-out is read-only; client cap short-circuits with a toast, server backstops it. |

---

## Critical (BLOCKS merge)

None.

---

## Should-fix (recommend before deploy; does not block)

- **SF-1 — `rename_store_count_layout` / `delete_store_count_layout` leak a
  layout-id existence oracle to any authenticated caller (gate ordering inverts
  the reference shape).**
  `supabase/migrations/20260706000000_store_count_layouts.sql:316-330`
  (rename) and `:376-388` (delete). Both RPCs resolve the target row and raise
  `P0002 'layout not found'` (step 2) **before** the `auth_is_privileged()` /
  `auth_can_see_store()` gate (step 3). Verified live: as staff-role manager
  `22222222…` (not a Charles member), calling
  `rename_store_count_layout(<real Charles layout id>, 'x')` returns
  **`42501`**, while `rename_store_count_layout(<random uuid>, 'x')` returns
  **`P0002`** — a differential a non-privileged, cross-store caller can use to
  confirm that a specific UUID names an existing layout row. Same result for
  `delete_store_count_layout`.

  **Impact (bounded — why this is Should-fix, not Critical):** the oracle leaks
  only a boolean "this exact 122-bit random UUID is a live layout row." It
  exposes no `store_id`, `name`, `item_ids`, or contents; it cannot be walked
  (UUIDv4, not enumerable); and it grants no write access — every write still
  refuses. The disclosed bit is near-worthless without an out-of-band source of
  layout ids. It is nonetheless a genuine deviation from (a) the audit contract
  "refusal that doesn't leak existence" and (b) the codebase's own reference
  RPC, which is explicit about avoiding exactly this: `demote_profile_to_user`
  (live `pg_get_functiondef`) runs the null-caller check → **role gate (step 2)**
  → then the destructive op, and its comment states *"A distinct string would
  leak that the auth was missing to a probing caller; the unified string is the
  safer surface."* Spec 110's `save_store_count_layout` already follows the safe
  order (role+store gate at steps 2–3, not-found at step 5) — only `rename` and
  `delete` invert it.

  **Fix:** move the `auth_is_privileged()` check ahead of the row-resolve `SELECT
  ... store_id` in both `rename_store_count_layout` and
  `delete_store_count_layout`, so a non-privileged caller gets a uniform
  `42501 'forbidden'` for both real and fake ids (the store gate can stay after
  the resolve, since it needs `v_store`; only the *role* gate needs to move up to
  close the oracle for non-privileged callers). This is a body-only RPC change
  (`create or replace function`), re-applied to prod via the same MCP path the
  migration used. Optionally add a pgTAP arm asserting a staff-role caller gets
  the **same** errcode for a real vs. fake id (the current suite pins the `42501`
  and `P0002` codes separately but never asserts they must be equal for the
  non-privileged path, so the oracle passed CI unnoticed).

---

## Nits (no action required for this spec)

- **N-1 — `service_role` holds EXECUTE on all three RPCs; the design (§4.2) and
  the reference `demote_profile_to_user` do not grant service_role.**
  `save/rename/delete_store_count_layout` `proacl` shows
  `service_role=X/postgres` (live), whereas `demote_profile_to_user` has only
  `postgres` + `authenticated`. The migration's explicit
  `revoke … from public, anon; grant … to authenticated;`
  (`:290-291`, `:350-351`, `:398-399`) does not revoke from `service_role`, so
  the `ALTER DEFAULT PRIVILEGES … TO service_role` (Supabase/spec-097 default)
  survives. **Not a vulnerability:** `service_role` bearers yield
  `auth.uid() = null`, and step 1 of every RPC fail-closes null callers with
  `42501` (verified in the function bodies) — a service_role invocation is
  refused before it can act. Flagged only as a fidelity gap vs. the stated
  "no service_role" intent; harmless because the null-caller guard is the real
  backstop. If exact parity with `demote_profile_to_user` is wanted, add
  `revoke execute … from service_role;` to the three RPCs.

- **N-2 — table grants to `anon`/`authenticated` include `TRUNCATE`, which the
  migration comment (`:135-136`) says is "deliberately OMITTED."**
  Live `role_table_grants` shows `anon` and `authenticated` both hold
  `TRUNCATE` on `store_count_layouts`. The migration's `grant select, insert,
  update, delete, references, trigger` block (`:137-138`) correctly omits
  TRUNCATE, but the project-wide `ALTER DEFAULT PRIVILEGES … TO anon,
  authenticated` (the Supabase default that spec-097 re-asserts) already granted
  it at table birth, so the explicit grant does not shrink it. **Not a
  spec-110 regression and not reachable as a vulnerability:** the identical
  grant exists on the sibling `user_count_orders` and every other `public.*`
  table (confirmed via `pg_default_acl`), PostgREST exposes no TRUNCATE verb, and
  TRUNCATE requires a direct SQL role session (not a JWT path). The comment is
  simply inaccurate about the effective ACL; the grant itself matches every
  other table in the schema. No action for this spec — if the project wants the
  comment to be true, that is a schema-wide `REVOKE TRUNCATE` decision, out of
  scope here.

---

## What was checked and is clean

- **RLS (all four policies, live):** SELECT `auth_can_see_store(store_id)` (any
  member reads); INSERT/UPDATE/DELETE `auth_is_privileged() AND
  auth_can_see_store(store_id)`. Each is a single PERMISSIVE policy per command
  with no `auth.uid() IS NOT NULL` OR-arm — no OR-compose shadow. RLS is
  `enable`d (`relrowsecurity = t`).
- **Write gate is server-side, not UI-only (AC-3b):** proven three ways for a
  staff-role session — RPC `42501`, direct INSERT RLS `42501`, direct
  UPDATE/DELETE 0 rows. Hiding the admin controls is necessary-not-sufficient
  and the server enforces the boundary independently.
- **Cap atomicity (OQ-6):** `pg_advisory_xact_lock(hashtext('store_count_layouts:'
  || p_store_id::text))` before the count+insert (`:270`), plus the structural
  `unique (store_id, position)` + `position between 1 and 3` CHECK ceiling. The
  advisory-lock key is a `uuid::text` fed to `hashtext()` — not a SQL string, not
  injectable.
- **No dynamic SQL:** zero `EXECUTE` / `format()` / `quote_*` / user-string
  concatenation into any statement in the three RPCs. `p_name` and `p_item_ids`
  are bound parameters into parameterized INSERT/UPDATE; the `jsonb` type +
  `jsonb_typeof = 'array'` CHECK + RPC guard reject malformed/ non-array input.
- **`created_by` not spoofable:** the create RPC hard-codes `created_by =
  auth.uid()` (`:283`); no RPC accepts a caller-supplied author. A privileged
  direct INSERT *could* forge `created_by`, but `created_by` is attribution-only
  (does not gate access, spec §1) and the direct path still requires the
  privileged RLS gate — no privilege or isolation consequence.
- **Name validation:** trim + length 1..60 enforced in both the RPC
  (`'layout name required'` / `'layout name too long'`) and the table CHECK;
  whitespace-only trims to empty → refused. Verified live (pgTAP arms 23–25).
- **Non-member read isolation:** staff-role non-member of Charles sees 0 Charles
  rows on both a qualified (`where store_id=charles`) and an unqualified SELECT;
  no row leaks into an unfiltered query.
- **AC-13 cleanup DELETE:** `DELETE FROM public.user_count_orders WHERE screen IN
  ('admin-inventory','staff-weekly')` (`:408-409`) — bounded to the two Weekly
  tokens; the two EOD tokens (`admin-eod`, `staff-eod`) and every other table are
  untouched. pgTAP arm (27) pins the predicate scoping directly.
- **Staff carve-out is read-only (`src/screens/staff/lib/countLayouts.ts`):**
  only a `.from('store_count_layouts').select(...)` SELECT; no
  insert/update/delete/upsert and no write-RPC reference anywhere in the staff
  subtree (grep-confirmed). The three write RPCs are called exclusively from
  `src/lib/db.ts:2430/2452/2473`.
- **Client-side 3-cap is UX-only:** `InventoryCountSection.tsx:494` / `:505`
  short-circuit with a toast before opening the name modal, but the server
  backstops with `P0001` regardless (proven live) — no security reliance on the
  client gate.
- **Secrets / PII:** none introduced. No service-role key, service token, or
  third-party key reachable from the client; no `EXPO_PUBLIC_*` addition; no
  token/PII in any log. Error messages are stable enum strings
  (`'forbidden'` / `'layout not found'` / `'layout limit reached'` / name
  validation) — no SQL fragments, stack traces, or cross-store row data.
- **Edge functions:** none created or modified; `config.toml` has no
  `store_count_layout` entry (correct — pure PostgREST + RLS + RPC). No
  `verify_jwt` / service-token surface in play.
- **Realtime:** table intentionally NOT in `supabase_realtime` (OQ-5); no
  cross-store replay surface added.

### Dependencies

No `package.json` changes — `npm audit` skipped. (`package.json` is absent from
the spec's `## Files changed` and untouched in git.)

---

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High. 1 Should-fix (SF-1: a
  bounded layout-id existence oracle in the rename/delete RPCs — role gate runs
  after the not-found check, so a non-privileged caller can distinguish a real
  layout id (42501) from a fake one (P0002); fix by moving the
  auth_is_privileged() check ahead of the row-resolve, body-only re-apply) and 2
  grant-posture Nits (N-1 service_role EXECUTE on the RPCs; N-2 TRUNCATE on the
  table) that are both project-wide defaults, not spec-110 regressions, and carry
  no reachable impact. No finding blocks; all 8 load-bearing claims verified
  against the live local stack. Write gate is genuinely server-side, the 3-cap is
  atomic + structurally ceilinged, the privilege model matches auth_is_privileged
  with no RPC/RLS drift, input has no injection surface, created_by is not
  spoofable, the AC-13 DELETE is bounded, and the staff surface is read-only.
payload_paths:
  - specs/110-named-weekly-count-layouts/reviews/security-auditor.md

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **SF-1 (layout-id existence oracle in rename/delete) — FIXED.** Both RPCs in
  `supabase/migrations/20260706000000_store_count_layouts.sql` now run the
  `auth_is_privileged()` role gate BEFORE the row-resolve (matching the
  `demote_profile_to_user` reference shape and `save_store_count_layout`'s
  existing order); the P0002 not-found branch is reachable only by privileged
  callers. Re-applied to the local stack (create or replace; gate order
  verified live via pg_proc position check). Three new pgTAP pins (18b/c/d):
  staff-role rename on a REAL id → 42501, rename on a FAKE id → SAME 42501
  (not P0002), delete on a FAKE id → SAME 42501 — the exact differential the
  audit demonstrated is now CI-guarded. plan 27 → 30; file 30/30, full suite
  63/63.
- **N-1 / N-2 (service_role EXECUTE; TRUNCATE grant) — NO ACTION**, per the
  audit's own framing: project-wide `ALTER DEFAULT PRIVILEGES` defaults
  identical to sibling tables, no reachable impact, not spec-110 regressions.
