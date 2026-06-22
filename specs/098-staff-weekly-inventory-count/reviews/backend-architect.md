# Backend-architect post-implementation review — Spec 098

Mode: post-implementation drift review (Status: READY_FOR_REVIEW).
Reviewer: backend-architect (author of the design in §0–§11 of the spec).
Scope: verify the implementation matches the contract I designed; flag drift
and design-integrity issues. Findings ranked Critical → Should-fix → Minor.

## Verdict

**No Critical findings. No contract drift.** The implementation matches the
backend design (§0–§11) on every load-bearing decision. Two Minor observations
and one Should-fix documentation/parity nit below; none block ship.

Files read this pass:
- `supabase/migrations/20260622090000_weekly_count_kind_and_cadence.sql`
- `supabase/migrations/20260622090100_weekly_reminder_log.sql`
- `supabase/migrations/20260513000000_inventory_counts.sql` (unchanged-allowlist check)
- `supabase/functions/weekly-reminder-cron/index.ts`
- `supabase/config.toml` (verify_jwt pins)
- `src/lib/db.ts` (fetchWeeklyCountStatus, updateStore, fetchRecentInventoryCounts)
- `src/types/index.ts`, `src/utils/enumLabels.ts`
- `src/screens/staff/store/useStaffStore.ts`
- `supabase/tests/submit_weekly_count.test.sql`
- `supabase/tests/submit_inventory_count_rejects_weekly.test.sql`
- `supabase/tests/weekly_count_status.test.sql`

## Contract conformance (each checklist item verified)

### Reuse-inventory_counts decision (§0) — MATCHES
- Migration A widens the `kind` CHECK to `('spot','open','mid_shift','close','weekly')`
  via a defensive drop-by-lookup + recreate (lines 35–54). The original spec-019
  inline CHECK at `20260513000000_inventory_counts.sql:75` was NOT mutated — correct
  (migrations are immutable; the widen is a separate ALTER). Additive/safe.
- **§0 point 1 (generic RPC still rejects 'weekly'):** confirmed. The in-body
  allowlist at `20260513000000_inventory_counts.sql:262` remains
  `('spot','open','mid_shift','close')` — unchanged, raises 22023 for `'weekly'`.
  Asserted by `submit_inventory_count_rejects_weekly.test.sql`.
- **Advisory snapshot (no stock write):** `submit_weekly_count` contains no
  `UPDATE inventory_items` (the only writes are to `inventory_counts` +
  `inventory_count_entries`). The explicit no-write comment is at line 186.
  Asserted by `submit_weekly_count.test.sql` step (5).

### submit_weekly_count RPC (§4a) — MATCHES
- Signature `(p_client_uuid, p_store_id, p_counted_at, p_entries, p_notes)
  returns jsonb` exactly as designed (lines 71–77).
- Auth gate FIRST via `auth_can_see_store` → 42501 (lines 91–94). Verified before
  any side-effect.
- Idempotent on store-scoped `(client_uuid, store_id)`, returns
  `{conflict:true}` on hit (lines 106–118), reusing the existing partial-unique
  index per design.
- `kind` hard-coded `'weekly'`; `submitted_by = auth.uid()` server-canonical
  (lines 123–133) — client cannot forge attribution or kind.
- Dual case/each entries handled (`actual_remaining`, `actual_remaining_cases`,
  `actual_remaining_each`), fully-blank skipped, non-negative (22023),
  item-in-store (23503), ≥1 kept entry required (22023). Matches §4a steps b–g.
- `REVOKE … FROM public, anon; GRANT … TO authenticated` present (lines 198–199).
- SECURITY INVOKER + `set search_path = public` (lines 79–80). Correct.

### weekly_count_status RPC (§4b, §3) — MATCHES
- Signature + return table match design (lines 223–234).
- Week window math uses `extract(dow from p_as_of_date)` (0=Sun..6=Sat), JS
  `getDay()` parity, **NOT** `isodow` (lines 259–260). Verified — this was the
  explicit §9 parity requirement.
- `window_end = as_of - ((dow(as_of) - due_dow + 7) % 7)`, `window_start =
  window_end - 6` (lines 257–272). Exact match to §3.
- Caller-supplied `p_as_of_date` drives the math; `now()::date` is NOT used —
  avoids the UTC off-by-one the spec warns about. Correct.
- `completed` test is a correlated lateral over `inventory_counts` with TZ-aware
  `(counted_at at time zone 'America/New_York')::date` in-window comparison
  (lines 284–294). Single-TZ assumption matches the cron and is documented.
- Returns `not_scheduled | completed | open | overdue` (lines 301–306).
  SECURITY INVOKER → RLS clips rows; `p_store_id NULL` → all visible stores
  (admin tab), non-null → one row (staff banner). Matches §4b.
- `REVOKE/GRANT` present (lines 312–313).

### stores.weekly_count_due_dow column + db.ts surface (§1, §6) — MATCHES
- `weekly_count_due_dow smallint NULL CHECK (… between 0 and 6)` (Migration A
  lines 61–63). NULL = not scheduled. Additive nullable, no backfill — safe on seed.
- `db.ts updateStore` Pick extended with `weeklyCountDueDow`, mapped to
  `weekly_count_due_dow`, passes null through to clear (db.ts:96, 107). Matches §6.
- `fetchStores`/`fetchStoresIncludingInactive` projections carry
  `weeklyCountDueDow` (db.ts:58, 82).
- `fetchWeeklyCountStatus(asOfDate)` calls `weekly_count_status` with
  `p_store_id: null`, maps snake→camel, wrapped in `useInflight.track({kind:'read'})`
  (db.ts:1034–1054). Matches §6 signature exactly.
- `fetchRecentInventoryCounts` gained the optional `kind` filter as a guarded
  `.eq('kind', kind)` (db.ts:979, 992) — the preferred cheaper-than-overfetch
  option from §6. Matches.
- Staff banner correctly does NOT route through db.ts — uses the direct
  `supabase.rpc` carve-out per spec 063 (useStaffStore.ts:173, 215). Matches §7.

### weekly-reminder-cron + config (§5) — MATCHES
- `config.toml` pins BOTH `[functions.weekly-reminder-cron] verify_jwt = false`
  AND `[functions.eod-reminder-cron] verify_jwt = false` (the §5 parity pin),
  with the documenting comment block at lines 430–442. Matches.
- Shared-bearer posture: validates the `_edge_auth.cron_bearer` via service_role,
  403 on mismatch (index.ts:136–160) — NOT per-user JWT. Matches §5.
- No `ADMIN_ROLES` set — correct per §5 (this is recipient targeting via
  `['admin','master']` + `user_stores`, not a caller role gate).
- `escapeHtml` inline five-char helper applied to every interpolated value in
  the HTML email body (index.ts:34–41, 310–311). Subjects/recipients not escaped
  (correct — not HTML). Matches the CLAUDE.md HTML-email rule and §5.
- Once-per-store-per-week dedup: pre-check against `weekly_reminder_log` for
  `(store_id, week_start)` (index.ts:288–290) + insert per user
  (index.ts:325–326), backed by the unique constraint. Self-filters to the due
  weekday (index.ts:263) and skips if already completed in-window
  (index.ts:274–282). Matches §5.
- Envelope `{ ok: true, summary: { weekly: [...] } }` (index.ts:334). Matches §5.7.
- The cron's `weekWindow()` JS math mirrors the SQL window math (index.ts:79–88),
  using UTC-noon arithmetic to dodge DST shifts. Consistent with the RPC.

### RLS four-policy / publication (§2, §8) — MATCHES
- `weekly_reminder_log`: RLS ENABLED, single SELECT policy via
  `auth_can_see_store(store_id)`, no insert/update/delete policy (service_role
  writes bypass RLS). The deliberate 3-fewer-than-four narrowing is documented
  in-migration (Migration B lines 11–24, 45–57). Matches §2; permissive-policy
  lint (spec 053) satisfied — predicate is not trivially-wide.
- `inventory_counts`/`inventory_count_entries`: zero RLS changes — weekly rows
  ride the existing per-store template. Matches §2.
- No `supabase_realtime` publication membership DDL in either migration;
  `inventory_counts` already published, `weekly_reminder_log` is service-only.
  **No `docker restart supabase_realtime_imr-inventory` step required** — the
  developer correctly did not add one. Matches §8.

## Should-fix (1)

**S1 — `weekly-reminder-cron` recipient set uses `['admin','master']`, not the
`auth_is_privileged()` triad.** index.ts:226 selects admin recipients as
`.in('role', ['admin','master'])`. The EOD cron uses the same pair, and §5
explicitly says no `ADMIN_ROLES` caller gate is needed here — so this is NOT a
caller-gate parity violation and NOT a security issue (it only affects who
*receives* a courtesy reminder). However, `auth_is_privileged()` is admin OR
super-admin, and the CLAUDE.md `ADMIN_ROLES` set is
`{admin, master, super_admin}`. A `super_admin` who is not a member of the store
via `user_stores` will silently NOT receive the weekly reminder. This is a
cosmetic recipient-coverage gap, consistent with the pre-existing EOD cron
behavior, and matches what §5 described ("union store members with admins"). I
flag it as Should-fix-or-consciously-accept: if super-admins are expected to get
store reminders, add `'super_admin'` to the role filter; otherwise add a one-line
comment noting the deliberate parity with the EOD cron's recipient set so a future
reader doesn't read it as a `auth_is_privileged` mirror omission.

## Minor (2)

**M1 — `'open'` status is unreachable by construction (documented, by design).**
Because `window_end` is always the most-recent occurrence of the due day,
`p_as_of_date >= window_end` always holds, so the uncompleted branch always
returns `'overdue'` and never `'open'` (RPC lines 301–306). This is NOT drift —
design §3 explicitly accepts the simplification ("open vs overdue collapses…
keep the three machine states distinct in the RPC; let the UI collapse them")
and the spec implementation-status note (lines 758–761) calls it out. The
`weekly_count_status.test.sql` header (lines 36–47) walks through and confirms
this is intentional. The dead `'open'` branch is harmless and keeps the machine
contract stable if a future "remind N days before" feature makes the window
end later than the due day. No action required; noting for the reviewer record.

**M2 — In-window completion query boundary in the cron uses a string literal
`T23:59:59.999`, the RPC uses a TZ-aware `::date between`.** index.ts:276–277
filters `counted_at` with `.gte('${windowStart}T00:00:00').lt('${windowEnd}T23:59:59.999')`
(naive, no TZ suffix → interpreted in the DB session TZ), whereas the RPC casts
`(counted_at at time zone 'America/New_York')::date between window_start and
window_end` (RPC lines 290–291). Both honor the single-TZ assumption documented
in §9, and the cron comment (index.ts:271–273) acknowledges the boundary skew as
the accepted single-TZ limitation. Functionally equivalent for America/New_York
in practice; the two paths could diverge by up to a few hours at the window
boundary if the DB session TZ is ever not UTC/NY. Minor consistency nit — the
cron could pass TZ-explicit timestamps to exactly mirror the RPC, but this is
within the documented v1 single-TZ tradeoff and does not affect correctness for
the configured deployment. No action required for ship.

## Notes on items I could not execute (not findings)

- pgTAP and the shell smoke were not run in the implementation environment
  (Docker down — spec lines 744–749). The three pgTAP files are written to
  convention and the assertions correctly target the four contract guarantees +
  window math + the generic-RPC regression. CI (`test.yml`) runs them; per the
  CLAUDE.md CI-status rule, the latest `test.yml` run on `main` must be green
  before SHIP_READY. Flagged to release-coordinator.
- Browser preview of the staff Weekly tab + admin weekly tab was not performed
  (preview tools unavailable — spec lines 870–874). The frontend code paths are
  guarded and tsc+jest pass; a reviewer should exercise both surfaces in the
  browser before ship, per the project's "verify UI with preview" convention.

## Summary

The backend implementation is a faithful realization of the design contract.
The load-bearing reuse decision (§0) is honored on all three coupling must-dos,
the two RPCs match their signatures and error semantics, RLS lands as designed
(including the deliberate narrowing on `weekly_reminder_log`), the cron uses the
correct shared-bearer posture with escapeHtml and once-per-week dedup, both
verify_jwt pins are in config.toml, and no realtime restart was spuriously added.
1 Should-fix (recipient-set coverage, cosmetic) and 2 Minor (both
already-documented design simplifications). Nothing blocks ship from an
architectural-drift standpoint.
