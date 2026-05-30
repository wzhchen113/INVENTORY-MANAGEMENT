## Test report for spec 075

### Acceptance criteria status

- AC1: `'Order missed'` added to the `AuditAction` TypeScript union in `src/types/index.ts` between `'Stock adjusted'` and the closing `;` → PASS — `src/types/index.ts:454` contains `| 'Order missed';` at the correct position; TypeScript's `Record<AuditAction, string>` exhaustiveness enforcement (in `formatAuditAction.ts:11`) validated this at typecheck time.

- AC2: `KEY_BY_ACTION` gains `'Order missed': 'orderMissed'`; all three i18n catalogs gain `enum.auditAction.orderMissed` with correct locale strings → PASS — `src/utils/formatAuditAction.ts:25` has the mapping; `src/i18n/en.json:1106`, `src/i18n/es.json:1106`, `src/i18n/zh-CN.json:1106` all carry `"orderMissed"` with `"order missed"` / `"pedido omitido"` / `"漏单"` respectively. i18n parity test (key-set equality) and enumLabels drift guard both green.

- AC3: `AuditLogSection.tsx:ACTION_TONE` gains `'Order missed': 'warn'`; `inferKind` maps `'Order missed'` to `'order'` → PASS — `src/screens/cmd/sections/AuditLogSection.tsx:32` has `'Order missed': 'warn'`; line 66 has `if (a === 'Order missed') return 'order';`.

- AC4: New SECURITY DEFINER RPC `public.record_missed_orders_for_day(p_date date)` exists, inserts one row per (store, vendor, date) satisfying all three predicates (schedule match, no purchase_orders, no existing audit_log triple), returns row count, is idempotent → PASS — pgTAP arm A (function signature), arm C.1 (returns 1 on first call), arm E1 (returns 0 on second call), arm E2 (3 calls → 1 row) all pass.

- AC5: Inserted rows have correct shape (`store_id`, `user_id=NULL`, `action='Order missed'`, `detail='<VendorName> order missed (<YYYY-MM-DD>)'`, `item_ref='vendor:<uuid>'`, `value=<VendorName>`, `created_at` defaults to `now()`) → PASS — pgTAP arm C.2 asserts all five non-default columns with exact values against the BJs/Towson/2026-05-25 fixture.

- AC6: pg_cron job `record-missed-orders-daily` calls RPC with yesterday-in-brand-TZ daily at 03:00 ET → PASS — migration `20260530000000_record_missed_orders_rpc.sql` installs `cron.schedule('record-missed-orders-daily', '0 7 * * *', ...)` with `((now() at time zone 'UTC') - interval '1 day')::date` as the date argument. Backend developer confirmed `cron.job` shows the schedule at `0 7 * * *` post-apply.

- AC7: One-shot 28-day backfill loop at migration apply time → PASS — migration contains the `DO $$ ... generate_series(today-28, today-1) ... $$` block. The architect's detail-string dedupe makes it safe to re-apply. Backend developer reports `total inserted = 0` against the empty-order_schedule seed (correct).

- AC8: RPC is `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `SET lc_time = 'C'` → PASS — `src/migrations/20260530000000_record_missed_orders_rpc.sql:131-133` shows all three function-level options set.

- AC9: Grants — `revoke all from public, anon, authenticated`; `grant execute to postgres, service_role` → PASS — pgTAP arm B uses `has_function_privilege` catalog-query pattern (NOT `set local role anon` — the spec-067 crash pattern is absent). Arm B confirms `anon=f`, `authenticated=f`, `service_role=t`, `postgres=t`.

- AC10: `AuditLogSection` feed tab renders new rows as warn-tone events with localized "order missed" verb. No new filter chip, no new tab → PASS — `ACTION_TONE['Order missed'] = 'warn'` is in place; the feed path is `fetchAuditLog` which does `select *` passing `action` verbatim. Browser visual verification not performed in this session (see Notes).

- AC11 (pgTAP — scheduled vendor, no submission → 1 row): PASS — arm C (C.1 + C.2).
- AC12 (pgTAP — re-running same date is a no-op): PASS — arm E1 (second call returns 0).
- AC13 (pgTAP — submission exists → 0 rows): PASS — arm D.
- AC14 (pgTAP — vendor-name match is case-insensitive): NOT TESTED via dedicated arm — the test file has no explicit arm for the ilike/lower case-sensitivity predicate (the spec's "pgTAP arm D" in the pgTAP test plan corresponds to the architect's arm D, which tests the *suppression* path, but uses an exact-case match fixture, not a mismatched-case one). **See gap note below.** However the RPC body explicitly uses `lower(coalesce(pv.name, '')) = lower(coalesce(v.name, os.vendor_name, ''))` which is directly derived from `cmdSelectors.ts:891-896` and the spec's design §"Vendor name normalization" — the correctness of the predicate itself is confirmed in code review; the absence of a case-mismatch fixture in pgTAP leaves a testing gap.
- AC15 (pgTAP — non-admin caller receives 4xx): PASS — arm B verifies via `has_function_privilege` that `authenticated` cannot EXECUTE (PostgREST returns 4xx when EXECUTE is denied).

### Test run

**Jest (full suite):**
Command: `npx jest --no-coverage`
Result: 380/380 passing across 39 test files (2 new tests added in this review pass).

**Typechecks:**
- `npx tsc --noEmit -p tsconfig.json` → exit 0
- `npx tsc --noEmit -p tsconfig.test.json` → exit 0

**pgTAP suite:**
Command: `bash scripts/test-db.sh`
Result: 38/38 DB test files pass.
New file `supabase/tests/missed_order_audit_rpc.test.sql`: 7 assertions pass (arms A, B, C.1, C.2, D, E1, E2).
Total suite: 38 files, assertion count varies per file (listed in runner output).

### Notes

**Gap: case-insensitive vendor-name match not directly pinned by a pgTAP fixture.**
The spec's pgTAP test plan named a "D: vendor-name match is case-insensitive" arm (architect's pgTAP test plan §pgTAP test plan item D). The implemented test file's arm D is the "negative case — submission exists → 0 rows" assertion (which uses an exact-case match fixture). The architect's test plan item D (the case-sensitivity test) is NOT present as a dedicated arm. The RPC body uses `lower(...) = lower(...)` which mirrors the TS predicate, and the code-review confirms correctness, but no pgTAP fixture exercises a mismatched-case vendor name (e.g., `order_schedule.vendor_name = 'us food'` with a `vendors.name = 'US FOOD'` purchase order row). This is a real but low-severity gap — the logic is trivially correct from the SQL perspective (`lower(x) = lower(y)`) and the migration's inline comment points to `cmdSelectors.ts:891-896` as the reference shape. Risk: low. Recommendation: add a ≤10-line fixture in arm D or as a new arm to pin parity between the SQL predicate and the TS predicate explicitly.

**pgTAP arms map to architect's arms as follows:**
- Architect arm A (function exists) → test arm A. PRESENT.
- Architect arm B (SECURITY DEFINER + grant lockdown via `has_function_privilege`, NOT `set local role anon`) → test arm B. PRESENT. Correctly uses catalog-query pattern.
- Architect arm C (positive case → 1 row with shape) → test arms C.1 + C.2. PRESENT.
- Architect arm D (negative case → 0 rows with submission) → test arm D. PRESENT. Note: arm D does not exercise the *case-insensitive* variant (see gap above).
- Architect arm E1 (idempotency, second call → 0) → test arm E1. PRESENT.
- Architect arm E2 (backfill: 3 calls → exactly 1 row) → test arm E2. PRESENT.
- Architect arm D (case-insensitive ilike match) → NOT PRESENT as a dedicated arm.

**FE jest coverage assessment:**
The `enumLabels.test.ts` `ACTIONS` array at line 64 includes `'Order missed'` (added by the frontend developer). The "every AuditAction value resolves to a non-empty translation in English" assertion at line 81 is structurally load-bearing: if `orderMissed` were missing from `en.json`, `T('enum.auditAction.orderMissed')` would return the dot-path `'enum.auditAction.orderMissed'`, and `expect(out).not.toMatch(/^enum\./)` would FAIL. The test is not vacuously passing.

The `i18n.test.ts` key-set parity test covers en/es/zh-CN equality — any catalog missing `orderMissed` would surface here. Both tests green.

**Two new spot-checks added in this review** (`src/utils/enumLabels.test.ts`):
- `returns Spanish translation for orderMissed (spec 075)` — asserts `formatAuditAction({action: 'Order missed'}, tFor('es'))` is `'pedido omitido'`. Pins the actual translated *value*, not just presence.
- `returns Chinese translation for orderMissed (spec 075)` — asserts result is `'漏单'`.
These are the only file modifications made in this review. Both new tests pass (380/380 total).

**Browser visual verification** was not performed — `AuditLogSection` renders new rows through the existing `fetchAuditLog` path with no new code branch. The frontend developer noted that the seed has 0 `'Order missed'` audit_log rows (expected: empty `order_schedule` at seed time). A reviewer with browser access can verify by hand-inserting a test row as described in the spec's §Files changed (frontend) section.

**E2 arm note:** The test file's own header (lines 36-42) acknowledges that within a single transaction the `created_at::date` key would coincidentally also pass arm E2 (all three calls share the same `created_at::date`). The arm confirms the detail-string dedupe works but does not definitively distinguish it from the PM-proposed broken approach. This is a known limitation documented in the test file itself — acceptable for a within-transaction pgTAP test.
