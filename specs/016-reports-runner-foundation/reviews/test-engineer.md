# Test report for Spec 016 — Reports Runner Foundation (REPORTS-1) — Round 2

## No test framework — reaffirmation

No jest, vitest, playwright, or `*.test.*` files exist. The three-layer approach from round 1 is unchanged (jest-expo + supabase test db + scripts/smoke-reports.sh). No framework was introduced; all checks are psql direct, PostgREST curl, and code reading. No change to this recommendation; user approval required per CLAUDE.md before any framework is added.

---

## Round-2 scope

Round 2 re-verifies all 27 acceptance criteria from round 1 and adds targeted verification for the four items patched since FIXES_NEEDED:

- **DB-9-TRIG** (new): trigger `report_runs_check_definition_consistency_trg` — Critical fix.
- **DB-9-RANBY** (new): `ran_by` default `auth.uid()` — High #1 fix.
- **DB.TS-1-SANITIZE** (new): error-message sanitization in `db.runReport` — High #2 fix.
- **STORE-3-REVERT** (new): `prev`-snapshot restore on catch — Should-fix #4.
- **FE-RDF-3-ACCENT** (new): `C.accentFg` on RUN button text — Should-fix #5, confirmed by main Claude.
- **FE-RS-7-ACCENT** (new): `C.accentFg` on `+ NEW REPORT` button — Should-fix #6, confirmed by main Claude.
- **FE-RDF-2-TYPED** (new): typed `params.range` lookup, no `as any` — Should-fix #7.

---

## Acceptance criteria status

### Database

- **DB-1: `report_runs` table exists with correct columns and types** — PASS (unchanged from round 1)
  - `\d public.report_runs` confirms all 10 columns with correct types and constraints. `ran_by` now shows `default auth.uid()` (round-2 change visible in DDL).

- **DB-2: Indexes on `(definition_id, ran_at desc)` and `(store_id, template_id, ran_at desc)`** — PASS (unchanged)
  - Both indexes confirmed: `report_runs_definition_ran_at_idx` (partial, `WHERE definition_id IS NOT NULL`) and `report_runs_store_template_ran_at_idx` (full).

- **DB-3: `definition_id` is nullable; consistency enforced by trigger (round-2 upgrade from RPC-only)** — PASS
  - `definition_id` is nullable. Round-2 migration `20260510130000_report_runs_consistency.sql` adds `report_runs_check_definition_consistency_trg` (BEFORE INSERT OR UPDATE, `tgenabled='O'`). Trigger raises `42501` when `definition_id` is non-null and `(store_id, template_id)` does not match the parent `report_definitions` row. Three exploit attempts verified:
    - Cross-store `store_id` mismatch: `ERROR: 42501 report_runs row inconsistent with parent definition`. BLOCKED.
    - Correct `store_id`, wrong `template_id`: same error. BLOCKED.
    - Fabricated `definition_id` (non-existent UUID): trigger catches the null lookup and raises. BLOCKED.
    - UPDATE re-point to foreign-store definition: same error. BLOCKED.
  - Legitimate inserts pass: `definition_id IS NULL` → trigger returns `new` immediately. `definition_id` consistent with `(store_id, template_id)` → row inserted successfully.

- **DB-4: Append-only retention, no automatic pruning** — PASS (unchanged)

- **DB-5: Permissive `"authenticated can do anything"` policy on `report_definitions` replaced** — PASS (unchanged)
  - Zero rows in `pg_policies` with `policyname ILIKE '%authenticated can do anything%'`. Eight `store_member_*` policies (four per table).

- **DB-6: `report_runs` RLS enabled with per-store policy shape** — PASS (unchanged)
  - `relrowsecurity = t` on both tables. All four policies on `report_runs` gating on `auth_can_see_store(store_id)`.

- **DB-7: Per-template RPC convention documented in migration header** — PASS (unchanged)
  - `20260510120000_report_runs.sql` lines 21-74 contain the full convention. The round-2 migration `20260510130000_report_runs_consistency.sql` adds a clear header documenting the Critical and High #1 fixes and the chosen Path A rationale.

- **DB-8: `report_run_stub` exists, `security invoker`, gated, granted to `authenticated`** — PASS (unchanged)
  - `prosecdef = f`. Stub returns full envelope with 1 KPI, 2 columns, 2 rows, 5-point series when called as authenticated admin with a valid `store_id`.

- **DB-9: `report_run` dispatcher routes `'stub'` to stub, returns `not_implemented` for unknown templates** — PASS (unchanged + Critical fix verified)
  - `report_run('stub', <store>, '{}')` → full stub envelope. `report_run('variance', <store>, '{}')` via PostgREST as admin → `{"kpis":[],"rows":[],"series":null,"_status":"not_implemented","columns":[],"_message":"Runner coming soon · definition saved"}`. Manager calling for unauthorized store → `{"code":"42501","message":"Not authorized for store ..."}`.
  - **DB-9-TRIG**: Trigger `report_runs_check_definition_consistency_trg` confirmed installed (`tgenabled='O'`, BEFORE INSERT OR UPDATE). Security-auditor Critical reproduction (cross-store INSERT spoof) now raises `ERROR: 42501` instead of `INSERT 0 1`. Critical CLOSED.
  - **DB-9-RANBY**: `column_default` on `ran_by` is `auth.uid()`. PostgREST INSERT omitting `ran_by` returns row with `ran_by = "11111111-1111-1111-1111-111111111111"` (the admin user's UUID). Server-side population confirmed. High #1 CLOSED.

### `src/lib/db.ts`

- **DB.TS-1: `db.runReport` calls `report_run` RPC then inserts into `report_runs`, returns camelCase row** — PASS
  - **DB.TS-1-SANITIZE**: `runReport` (`src/lib/db.ts:1649-1707`) no longer includes `ran_by` in the INSERT object (comment at line 1695-1697 makes intent explicit). Error-message sanitization at lines 1668-1678: if `rpcError.message.startsWith('Not authorized')` → passed through verbatim; else → `'Run failed — check server logs'` + `console.warn('[Supabase] runReport RPC failed:', rpcError)`. High #2 CLOSED.
  - `not_implemented` envelope (no RPC error) → `status = 'ok'`, `errorMessage = null` (falls into the `else` branch at line 1679). The `_status` field travels inside `output` jsonb for the frame to branch on. Correct.
  - Insert throws on failure (does not swallow) — unchanged from round 1.

- **DB.TS-2: `db.fetchLatestRun` returns most recent row or null, camelCase** — PASS (unchanged)

- **DB.TS-3: snake_case → camelCase convention followed** — PASS (unchanged)

### `src/store/useStore.ts`

- **STORE-1: `reportRuns: Record<string, ReportRun>` slice** — PASS (unchanged)

- **STORE-2: `runReport` optimistic-then-revert + `notifyBackendError('Run report')`** — PASS
  - **STORE-3-REVERT**: `runReport` catch block at `src/store/useStore.ts:1881-1892` now snapshots `prev = (get().reportRuns || {})[definitionId] ?? null` before the optimistic write (line 1849). On catch: if `prev` is truthy, restores `next[definitionId] = prev`; else deletes the key. A user with a previously-resolved run who triggers an RLS-rejected retry will see the last-good run restored, not "No runs yet". Should-fix #4 CLOSED.
  - `ranBy` field removed from `db.runReport` call (line 1870-1875). `ranBy` kept only on the optimistic display row (line 1864) with a comment explaining it does not travel to the server.

- **STORE-3: `loadLatestRun` lazy read, `console.warn` on error** — PASS (unchanged)

- **STORE-4: No new `loadFromSupabase` wiring** — PASS (unchanged)

### Frontend — `ReportsSection.tsx`

- **FE-RS-1: `templates.ts` single source of truth** — PASS (unchanged)

- **FE-RS-2: 8-element array deleted, 6-tile catalog from TEMPLATES** — PASS (unchanged)

- **FE-RS-3: No fake numbers, PREVIEW badge on all tiles** — PASS (unchanged)

- **FE-RS-4: Catalog tile opens modal pre-filled** — PASS (unchanged)

- **FE-RS-5: Saved-report tile opens detail view** — PASS (unchanged)

- **FE-RS-6: Back button returns to list** — PASS (unchanged)

- **FE-RS-7: Escape key (web) closes detail view** — PASS (unchanged from round 1)
  - **FE-RS-7-ACCENT** (`+ NEW REPORT` button text): `src/screens/cmd/sections/ReportsSection.tsx:138` → `color: C.accentFg`. No `'#000'` literal. Confirmed by main Claude (dark mode `#0E1014` on green, light mode `#FFFFFF` on dark green — both WCAG-compliant). Should-fix #6 CLOSED. PASS.

### Frontend — `ReportDetailFrame`

- **FE-RDF-1: `ReportDetailFrame.tsx` exists with correct props interface** — PASS (unchanged)

- **FE-RDF-2: Header, KPI strip, table, optional chart; `params.range` typed, no `as any`** — PASS
  - **FE-RDF-2-TYPED**: `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:90-91`:
    ```ts
    const range = definition.params?.['range'];
    const rangeChip = typeof range === 'string' ? `range: ${range}` : 'range: last 30d';
    ```
    `definition.params` is `Record<string, unknown>`; the bracket lookup returns `unknown`; the `typeof` guard narrows to `string` before use. No `as any` cast present anywhere in the file's range-chip logic. Should-fix #7 CLOSED.

- **FE-RDF-3: Three empty states: null/not_implemented/error** — PASS (unchanged from round 1)
  - **FE-RDF-3-ACCENT** (RUN button text): `src/screens/cmd/sections/reports/ReportDetailFrame.tsx:164` → `color: runDisabled ? C.fg3 : C.accentFg`. No `'#000'` literal. Confirmed by main Claude. Should-fix #5 CLOSED. PASS.

- **FE-RDF-4: Date-range chip, read-only, defaults to "last 30d"** — PASS (unchanged)

---

## New acceptance criteria (round-2 additions)

- **DB-9-TRIG: Trigger blocks cross-store INSERT spoof (Critical fix)** — PASS
  - All four exploit vectors blocked: store_id mismatch, template_id mismatch, fabricated definition_id, UPDATE re-point. Legitimate inserts (`definition_id IS NULL`, or `definition_id` consistent) succeed.

- **DB-9-RANBY: `ran_by` populated server-side from `auth.uid()` (High #1 fix)** — PASS
  - `column_default = auth.uid()`. PostgREST INSERT without `ran_by` field returns row with correct `ran_by` matching the JWT `sub`.

- **DB.TS-1-SANITIZE: Error-message sanitization (High #2 fix)** — PASS
  - `Not authorized for store ...` message passes through verbatim (confirmed: PostgREST returns this exact string from the `42501` raise). All other errors replaced with generic copy + `console.warn`. Code reading confirms the `startsWith('Not authorized')` guard at `db.ts:1673`.

- **STORE-3-REVERT: `prev`-snapshot restore on error (Should-fix #4)** — PASS
  - `prev` snapshotted before optimistic write. Catch block restores `prev` if truthy, else deletes the key. Pattern matches `deleteReportDefinition` reference implementation.

- **FE-RDF-3-ACCENT: `C.accentFg` on RUN button text (Should-fix #5)** — PASS (browser-verified by main Claude)

- **FE-RS-7-ACCENT: `C.accentFg` on `+ NEW REPORT` text (Should-fix #6)** — PASS (browser-verified by main Claude)

- **FE-RDF-2-TYPED: Typed `params.range` pattern, no `as any` (Should-fix #7)** — PASS

---

## Test run

No automated test runner exists. Round-2 checks performed via:

- `docker exec supabase_db_imr-inventory psql -U postgres -d postgres` — trigger existence, `ran_by` default, RLS policies, exploit repros, legitimate inserts.
- `curl` against `http://127.0.0.1:54321` with authenticated JWTs (admin and manager roles) — RPC envelope shapes, unauthorized-store rejection, PostgREST `ran_by` population.
- Code reading — `db.ts` sanitization logic, `useStore.ts` `prev`-snapshot pattern, `ReportDetailFrame.tsx` typed range pattern, `ReportsSection.tsx` and `ReportDetailFrame.tsx` color literals.
- `npx tsc --noEmit` — zero new errors in `src/lib/db.ts`, `src/store/useStore.ts`, `src/types/index.ts`, `src/screens/cmd/sections/reports/`, or `src/screens/cmd/sections/ReportsSection.tsx`. Pre-existing errors in `AdminScreens.tsx`, `AppNavigator.tsx`, `IngredientEditor.tsx`, `EODCountScreen.tsx`, `IngredientsScreen.tsx`, `InventoryDesktopLayout.tsx`, `webPush.ts` are unchanged.

Pass/fail counts: **34 PASS / 0 FAIL / 0 NOT TESTED** across 27 original ACs + 7 round-2 ACs.

**BLOCK decision: NO.** All acceptance criteria pass. All Critical, High, and Should-fix items from the FIXES_NEEDED round are closed.

---

## Manual smoke checklist — round 2 (for reviewer to run after pulling the patch)

Run `npm run dev:db` (or verify `docker ps` shows the local stack up) then:

```
DB layer (psql):

1. [ ] docker exec supabase_db_imr-inventory psql -U postgres -d postgres \
        -c "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.report_runs'::regclass"
       → report_runs_check_definition_consistency_trg present, tgenabled='O'.

2. [ ] docker exec supabase_db_imr-inventory psql -U postgres -d postgres \
        -c "SELECT column_default FROM information_schema.columns \
            WHERE table_schema='public' AND table_name='report_runs' AND column_name='ran_by'"
       → auth.uid()

3. [ ] Reproduce Critical exploit attempt:
       docker exec supabase_db_imr-inventory psql -U postgres -d postgres -c "
         INSERT INTO public.report_definitions (store_id, template_id, name, params)
           VALUES ('<store-A-uuid>', 'cogs', 'TE Def A', '{}') RETURNING id;"
       # use that id as <def-id-A>
       INSERT INTO public.report_runs
         (definition_id, template_id, store_id, params, output, status)
       VALUES
         ('<def-id-A>', 'cogs', '<store-B-uuid>', '{}', NULL, 'ok');
       → ERROR: 42501: report_runs row inconsistent with parent definition

4. [ ] Verify ran_by auto-population: INSERT into report_runs via PostgREST without
       ran_by field; confirm returned row has ran_by = admin user UUID.

5. [ ] SELECT policyname FROM pg_policies WHERE tablename IN
        ('report_definitions', 'report_runs') ORDER BY tablename, policyname;
       → 8 rows, all store_member_* — no "authenticated can do anything".

UI layer (browser at http://localhost:8081/):

6. [ ] Light mode: + NEW REPORT button text is white (#FFFFFF) on dark green.
       Dark mode: + NEW REPORT button text is #0E1014 on bright green.
       Both pass WCAG AA.

7. [ ] Open a saved report detail. RUN button text is white (light) or #0E1014 (dark)
       — not black (#000) in either mode.

8. [ ] Create a report, press RUN once (→ not_implemented state, RUN disabled).
       Reload the page, reopen detail. "Runner coming soon" still shows
       (latestRun loaded from DB via loadLatestRun).

9. [ ] Verify range chip reads "range: last 30d" when params.range is unset.

10.[ ] Press Escape — returns to list. Press BACK button — same result.
```

---

## Retained notes from round 1 (no change)

1. **react-native-chart-kit vs react-native-svg**: Spec mentions react-native-chart-kit; implementation uses react-native-svg inline (matching StockHistoryChart). Deliberate, approved by architect.

2. **Pre-existing cold-boot errors**: ~436 React `Maximum update depth` errors in Inventory section pre-date Spec 016. Separate investigation.

3. **`FOR ALL TABLES` realtime publication**: `report_runs` is replicated because `20260502190000_realtime_publication.sql` uses `FOR ALL TABLES`. No realtime consumer reads from it today. Informational only.

4. **`running` prop cleared in same microtask**: Minor cosmetic gap. RUN button correctly disabled via `latestRun.status === 'pending'`. Recommend addressing in REPORTS-2.

5. **No test framework**: Three-layer recommendation (jest-expo + supabase test db + smoke-reports.sh) unchanged. No framework added without user approval.

---

## Summary table

| # | Criterion | R1 | R2 |
|---|-----------|----|----|
| DB-1 | `report_runs` table with correct columns/types | PASS | PASS |
| DB-2 | Indexes | PASS | PASS |
| DB-3 | `definition_id` nullable; consistency now trigger-enforced | PASS | PASS |
| DB-4 | Append-only retention | PASS | PASS |
| DB-5 | Permissive policy on `report_definitions` replaced | PASS | PASS |
| DB-6 | `report_runs` RLS enabled, four per-store policies | PASS | PASS |
| DB-7 | Per-template RPC convention in migration header | PASS | PASS |
| DB-8 | `report_run_stub` security invoker, gated | PASS | PASS |
| DB-9 | Dispatcher routing; Critical trigger fix | PASS | PASS |
| DB-9-TRIG | Trigger blocks cross-store spoof (new) | — | PASS |
| DB-9-RANBY | `ran_by` server-populated from `auth.uid()` (new) | — | PASS |
| DB.TS-1 | `db.runReport` RPC + insert + camelCase | PASS | PASS |
| DB.TS-1-SANITIZE | Error-message sanitization (new) | — | PASS |
| DB.TS-2 | `db.fetchLatestRun` | PASS | PASS |
| DB.TS-3 | snake_case → camelCase convention | PASS | PASS |
| STORE-1 | `reportRuns` slice | PASS | PASS |
| STORE-2 | `runReport` optimistic-then-revert | PASS | PASS |
| STORE-3-REVERT | `prev`-snapshot restore on error (new) | — | PASS |
| STORE-3 | `loadLatestRun` lazy read | PASS | PASS |
| STORE-4 | No `loadFromSupabase` wiring | PASS | PASS |
| FE-RS-1 | `templates.ts` single source of truth | PASS | PASS |
| FE-RS-2 | 6-tile catalog from TEMPLATES | PASS | PASS |
| FE-RS-3 | No fake numbers, PREVIEW badge | PASS | PASS |
| FE-RS-4 | Catalog tile opens modal pre-filled | PASS | PASS |
| FE-RS-5 | Saved-report tile opens detail | PASS | PASS |
| FE-RS-6 | Back button returns to list | PASS | PASS |
| FE-RS-7 | Escape key (web) closes detail | PASS | PASS |
| FE-RS-7-ACCENT | `C.accentFg` on `+ NEW REPORT` (new) | — | PASS |
| FE-RDF-1 | `ReportDetailFrame.tsx` props interface | PASS | PASS |
| FE-RDF-2 | Header/KPI/table/chart layout | PASS | PASS |
| FE-RDF-2-TYPED | Typed `params.range`, no `as any` (new) | — | PASS |
| FE-RDF-3 | Three empty states | PASS | PASS |
| FE-RDF-3-ACCENT | `C.accentFg` on RUN button text (new) | — | PASS |
| FE-RDF-4 | Date-range chip read-only | PASS | PASS |

**34 PASS / 0 FAIL / 0 NOT TESTED. No BLOCK.**
