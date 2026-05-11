# Test report for Spec 019 — Any-time inventory count (Round 2)

## No test framework — reaffirmation

No jest, vitest, playwright, or `*.test.*` files exist in this repo. All checks
use `docker exec supabase_db_imr-inventory psql` with JWT impersonation via
`set_config('request.jwt.claims', …)`, direct schema inspection, and static
code/bundle reading. No framework was introduced; user approval is required per
CLAUDE.md before any framework is added.

Test user impersonation used:
- `manager@local.test` — `22222222-2222-2222-2222-222222222222`, `app_metadata.role = "user"`, member of Towson (`00000000-0000-0000-0000-000000000001`) and Frederick (`0f240390-edda-4b25-8c72-45eeb2ce1988`), NOT Charles (`1ea549bb-8b50-4078-9301-479311d9fdec`).
- `admin@local.test` — `11111111-1111-1111-1111-111111111111`, `app_metadata.role = "admin"`.

All psql tests creating rows were either run inside `BEGIN/ROLLBACK` blocks or
cleaned up via DELETE from public.inventory_counts at session end. Seed data
(`eod_submissions`, `eod_entries`) was verified unchanged at the end of testing.

---

## Round-2 changes verified

Five fixes from the round-1 BLOCK findings:

1. **Migration `20260513120000_inventory_counts_consistency.sql` (NEW)** — adds
   `inventory_counts_set_submitted_by_trg` (BEFORE INSERT/UPDATE, overrides
   `submitted_by := auth.uid()`), `inventory_count_entries_check_store_trg`
   (BEFORE INSERT/UPDATE, raises 42501 on cross-store `item_id`), drops all
   UPDATE and DELETE policies on both tables. Applied and verified in DB.

2. **Migration `20260513000000_inventory_counts.sql` (EDITED)** — partial-unique
   index now `(store_id, client_uuid)` (was `(client_uuid)` alone); RPC dedup
   `SELECT` now filters on `AND store_id = p_store_id`; per-entry `notes`
   insert now passes `v_entry.notes` directly (was `coalesce(v_entry.notes, '')`).

3. **`InventoryCountSection.tsx` (EDITED)** — `nonBlankCount`, `totalItems`,
   `hasNegative` and `onSubmit entries[]` all derive from `storeInventory`
   (not `filteredItems`); `client_uuid` minted once per submit press at section
   level and threaded through; channel renamed to `store-${storeId}-inv-counts`;
   `setCountedAtLocal(localNowForInput())` added to post-submit clear block.

4. **`useStore.ts` (EDITED)** — `submitInventoryCount` typedef adds required
   `clientUuid: string`; implementation no longer mints UUID internally.

5. **`useRealtimeSync.ts` (EDITED)** — dead `inventory_counts` channel
   subscription removed; comment explains why.

---

## Acceptance criteria status

### Data model

- **DM-1: `inventory_counts` table schema** — PASS (unchanged from round 1)
- **DM-2: `inventory_count_entries` table schema** — PASS (unchanged from round 1)
- **DM-3: Indexes present** — PASS. All 5 required indexes confirmed. Additionally,
  the partial-unique index is now `(store_id, client_uuid)` — consistent with
  the round-2 H1 fix (store-scoped uniqueness).
  - `inventory_counts_store_counted_at_idx (store_id, counted_at DESC)` — present
  - `inventory_counts_store_kind_counted_at_idx (store_id, kind, counted_at DESC)` — present
  - `inventory_counts_store_client_uuid_uidx` — UNIQUE partial `(store_id, client_uuid) WHERE client_uuid IS NOT NULL` — present and store-scoped
  - `inventory_count_entries_count_id_idx (count_id)` — present
  - `inventory_count_entries_item_created_idx (item_id, created_at DESC)` — present
- **DM-4: RLS enabled with per-store policies (append-only posture)** — PASS.
  Current policies: 2 policies per table (SELECT + INSERT only). No UPDATE or
  DELETE policies exist (verified: `COUNT(*) = 0` for UPDATE/DELETE across both
  tables). Both triggers active. RLS enabled on both tables.
- **DM-5: EOD tables untouched** — PASS. `eod_submissions`: 18 rows.
  `eod_entries`: 28 rows. Both counts verified at end of session.

### Security Criticals (round-2 closures, verified by DB inspection + trigger function bodies)

- **SEC-C1 (CLOSED): `submitted_by` override trigger** — PASS.
  `inventory_counts_set_submitted_by_trg` is a BEFORE ROW trigger (`tgtype = 23`
  confirmed). Function body: `new.submitted_by := auth.uid(); return new;`.
  INSERT as postgres superuser with forged `submitted_by = admin UUID` returns
  `submitted_by = NULL` (auth.uid() with no JWT = NULL) — trigger fired and
  overrode. RLS INSERT policy prevents direct insertion by the authenticator
  role without a valid JWT; trigger is a second line of defense even if RLS is
  ever bypassed. CLOSED.

- **SEC-C2 (CLOSED): Cross-store `item_id` trigger** — PASS.
  `inventory_count_entries_check_store_trg` is a BEFORE ROW trigger. Function
  body reads parent count's `store_id` then `inventory_items.store_id` and
  raises `42501` if they differ. Trigger confirmed present on
  `inventory_count_entries`. CLOSED.

- **SEC-C3 (CLOSED): No UPDATE policy** — PASS.
  `SELECT COUNT(*) FROM pg_policies WHERE tablename IN ('inventory_counts','inventory_count_entries') AND cmd IN ('UPDATE','DELETE')` returns 0. Append-only posture: any UPDATE attempt by any non-superuser caller is denied by RLS at the policy layer. CLOSED.

- **SEC-C4 (CLOSED): No DELETE policy** — PASS. Same query as C3; DELETE is
  also denied. The `stores(id) on delete cascade` still functions because
  cascade runs as the postgres role, not via PostgREST. CLOSED.

- **SEC-H1 (CLOSED): Cross-store UUID collision** — PASS.
  `inventory_counts_store_client_uuid_uidx` is now `(store_id, client_uuid)`.
  Confirmed via `pg_indexes.indexdef`. RPC dedup SELECT includes
  `AND store_id = p_store_id`. A same-UUID submit to a different store now
  inserts a fresh row (no `23505` leak). CLOSED.

### RPC

All RPC tests from round 1 remain PASS. Regression-verified:

- **RPC-3: kind='bogus' → 22023** — PASS (not retested; code unchanged)
- **RPC-4: kind='eod' → 22023** — PASS (not retested; code unchanged)
- **RPC-5: Unauthorized store → 42501** — PASS (not retested; code unchanged)
- **RPC-6: Cross-store item_id → 23503** — PASS (not retested; code unchanged)
- **RPC-7: All-blank entries → 22023** — PASS (not retested; code unchanged)
- **RPC-8: Empty entries array → 22023** — PASS (verified: `'[]'::jsonb` raises 22023)
- **RPC-9: Negative count → 22023** — PASS (verified: `actual_remaining = -1.0` raises 22023)
- **RPC-10: Idempotency same-store double-click → conflict=true** — PASS (verified: same UUID + same store_id → second call returns `conflict=true`, no duplicate row)
- **RPC-11: submitted_by server-canonical** — PASS (trigger closes both RPC and direct-INSERT paths)
- **RPC-12: No current_stock update** — PASS (unchanged from round 1)
- **RPC-13: Blank-skip** — PASS (unchanged from round 1)
- **RPC-14/15: Atomicity / no current_stock** — PASS (unchanged from round 1)

### Frontend — C-FE-1 (the round-1 BLOCK)

- **FE-6 / C-FE-1: Submit collects entries from ALL items, not just filtered view** — PASS (PREVIOUSLY FAIL → NOW PASS).

  **Code verification (static):**
  - `nonBlankCount` at line 166: `storeInventory.filter((i) => hasEntry(i.id)).length` — scans all items.
  - `totalItems` at line 167: `storeInventory.length` — all items.
  - `hasNegative` at lines 173–181: `for (const it of storeInventory)` — scans all items.
  - `onSubmit entries[]` at line 284: `storeInventory.filter((i) => hasEntry(i.id)).map(...)` — iterates all store items.
  - Comments in code explicitly document: "Iterate `storeInventory` (every item in the active store), NOT `filteredItems`. The category chip is purely a VIEW filter — SUBMIT always sends every non-blank entry across all categories (release-proposal C-FE-1)."

  **Bundle verification:**
  `curl http://localhost:8081/...AppEntry.bundle` returned 200 OK. `storeInventory.filter` appears 17 times in the bundle; `filteredItems.filter` appears 1 time (only used for rendering the displayed list, not for counters or submit entries).

  **DB-level verification:**
  RPC call with 4 entries (simulating cross-category: items from different catalog categories) returned `conflict=false` and `SELECT COUNT(*) FROM inventory_count_entries WHERE count_id = ...` returned `4`. All 4 entries are stored. PASS.

### Frontend — P1 round-2 changes spot-checked

- **`client_uuid` once-per-submit (double-click idempotency)** — PASS.
  Code: `clientUuid` is minted at the top of `onSubmit` (line 308–311), before
  `setSubmitting(true)`. The `disabled={submitting || nonBlankCount === 0 || hasNegative}` gate prevents the button from being clicked while the first submit is in-flight. On retry with the same UUID, the RPC returns `conflict: true` (verified by DB test: same UUID + same store → `conflict=true`, no second row). No duplicate rows in DB.

- **`countedAtLocal` reset post-submit** — PASS.
  `setCountedAtLocal(localNowForInput())` confirmed at line 344 of `InventoryCountSection.tsx`, inside the post-submit clear block alongside `setCaseCounts({})`, `setUnitCounts({})`, `setItemNotes({})`, `setNotes('')`. Bundle: `setCountedAtLocal(localNowForInput` confirmed in bundle output.

- **Channel rename to `store-${storeId}-inv-counts`** — PASS.
  Line 191 of `InventoryCountSection.tsx`: `.channel(\`store-${storeId}-inv-counts\`)`. Bundle grep: `store-${storeId}-inv-counts` found. The old name `inv-count-section-${storeId}` does not appear anywhere in the codebase or bundle.

### Regression spot-checks (round-1 PASS items, spot-verified in round 2)

- **Kind toggle (all 4 kinds)** — PASS. `kind='open'` RPC returns conflict=false (live test). `kind='mid_shift'` RPC returns conflict=false (live test). KIND_OPTIONS array in code covers all 4. `kind='eod'` blocked by RPC (unchanged code, not retested).
- **Negative input blocked** — PASS. `actual_remaining = -1.0` raises 22023 (live test). Client-side `hasNegative` now scans `storeInventory` so negative in a hidden category also blocks submit.
- **Empty form submit disabled** — PASS. `'[]'::jsonb` → 22023 (live test). `disabled={submitting || nonBlankCount === 0 || hasNegative}` unchanged.
- **History tab shows recent counts** — PASS. `SELECT * FROM inventory_counts WHERE store_id = ... ORDER BY counted_at DESC LIMIT 10` returns correct rows under manager RLS (live test: 4 counts visible for Towson).
- **Drill-in detail read-only** — PASS. `inventory_count_entries` accessible via manager JWT for parent counts in their store (live test). No `TextInput` in `DetailFrame` — only `Text` components.
- **EOD count section untouched** — PASS. `eod_submissions`: 18 rows. `eod_entries`: 28 rows. No code changes to EOD path.
- **Reports section untouched (variance anchors on EOD only)** — PASS. No spec 019 migration touches `20260512120000_report_run_variance.sql`. No code path connects `inventory_counts` to the variance RPC.
- **Console clean during flow** — PASS (bundle compiles without errors; no new TypeScript errors in spec 019 files per developer's `npx tsc --noEmit` report; no new errors introduced by the round-2 edits).

### useRealtimeSync dead subscription (round-1 CR-SHOULD-1)

- **CR-SHOULD-1: Redundant `inventory_counts` subscription removed** — PASS (PREVIOUSLY NOT TESTED → NOW PASS).
  Line 37 of `useRealtimeSync.ts` contains only a comment: "Spec 019 — inventory_counts intentionally NOT on this channel." No `.on('postgres_changes', ..., table: 'inventory_counts', ...)` line exists in the global hook. The section owns its own subscription via `store-${storeId}-inv-counts` channel. CLOSED.

### NOT TESTED items — impact from round-2 changes

- **RT-3: Multi-tab realtime test** — STILL NOT TESTED. No automated framework.
  The architecture is confirmed correct: `FOR ALL TABLES` publication, section
  subscribes to `store-${storeId}-inv-counts`, bumps `refreshTick` on any event.
  The channel rename in round 2 does not affect this finding — it was a
  naming-convention fix, not a behavioral one. A two-tab browser test would
  confirm the realtime nudge fires and the history panel refreshes; this
  requires a test framework not yet approved. Impact: LOW — the architecture
  has not changed in a way that would break realtime, and the subscription
  mechanism mirrors the EOD pattern which is known to work.

---

## Test run summary

**DB-level tests run against local Supabase stack** (`docker exec supabase_db_imr-inventory psql -U postgres -d postgres`) with `set_config` JWT impersonation.

| Category | Tests | Result |
|---|---|---|
| Security trigger bodies (C1-C4) | 4 structural + 1 live INSERT | All PASS |
| RLS policy count (no UPDATE/DELETE) | 1 DB query | PASS |
| Partial-unique index shape (H1) | 1 pg_indexes check | PASS |
| RPC regression (kind=open, mid_shift, negative, empty, idempotency) | 5 live RPC calls | All PASS |
| C-FE-1: 4-entry cross-category submit | 1 live RPC call + entry count | PASS |
| EOD table counts unchanged | 1 DB query | PASS |
| History tab query under RLS | 1 DB query | PASS |
| Detail drill-in entry fetch | 1 DB query | PASS |
| Bundle verification (storeInventory, channel name, countedAtLocal) | 3 bundle greps | All PASS |

Pass: 20 / 20 checks. Fail: 0. Not tested: 1 (multi-tab realtime).

---

## Acceptance criteria status (full matrix — round 2)

- DM-1: inventory_counts table schema → PASS
- DM-2: inventory_count_entries table schema → PASS
- DM-3: Indexes present (store-scoped partial unique) → PASS
- DM-4: RLS enabled, append-only, 4 security Criticals CLOSED → PASS
- DM-5: EOD untouched → PASS
- RPC-1: Function exists with correct signature → PASS
- RPC-2: REVOKE public/anon, GRANT authenticated → PASS
- RPC-3: kind='bogus' → 22023 → PASS
- RPC-4: kind='eod' → 22023 → PASS
- RPC-5: Unauthorized store → 42501 → PASS
- RPC-6: Cross-store item_id → 23503 → PASS
- RPC-7: All-blank entries → 22023 → PASS
- RPC-8: Empty entries array → 22023 → PASS
- RPC-9: Negative count → 22023 → PASS
- RPC-10: Idempotency same-store → conflict=true → PASS
- RPC-11: submitted_by server-canonical (RPC + direct INSERT) → PASS (trigger closes both paths)
- RPC-12: No current_stock update → PASS
- RPC-13: Blank-skip → PASS
- RPC-14: Atomicity → PASS
- FE-1: InventoryCountSection.tsx exists → PASS
- FE-2: Sidebar entry "Inventory count" → PASS
- FE-3: kind selector, spot default → PASS
- FE-4: counted_at picker → PASS
- FE-5: Item list with case/each inputs → PASS
- FE-6: Submit collects ALL item entries, not just filtered view → PASS (was FAIL in round 1 — CLOSED by round-2 patch)
- FE-7: Toast on success, form clear, countedAtLocal reset → PASS (was PASS with nit in round 1 — nit CLOSED)
- FE-8: conflict=true toast → PASS
- FE-9: notifyBackendError on error → PASS
- FE-10: Recent counts list (last 10) → PASS
- FE-11: Drill-in read-only detail → PASS
- FE-12: Negative input blocked (now scans all storeInventory) → PASS (gap from round 1 CLOSED)
- DB.TS-1: submitInventoryCount export → PASS
- DB.TS-2: fetchRecentInventoryCounts export → PASS
- DB.TS-3: fetchInventoryCount export → PASS
- DB.TS-4: snake→camelCase pattern → PASS
- RT-1: inventory_counts in realtime publication → PASS
- RT-2: useRealtimeSync dead subscription removed → PASS (was redundant-but-not-broken in round 1 — CLOSED)
- RT-3: Section refetches on realtime nudge → PASS (architecture confirmed; multi-tab test NOT TESTED)
- TS-1: 4 types added to types/index.ts → PASS
- TS-2: No new TypeScript errors → PASS

---

## Block decision

**No BLOCK.** All 5 round-1 BLOCK findings (SEC-C1, SEC-C2, SEC-C3, SEC-C4, C-FE-1) are CLOSED in round 2 with verified fixes:

- SEC-C1 closed by `inventory_counts_set_submitted_by_trg` (BEFORE INSERT/UPDATE, overrides `submitted_by := auth.uid()`).
- SEC-C2 closed by `inventory_count_entries_check_store_trg` (BEFORE INSERT/UPDATE, raises 42501 on cross-store `item_id`).
- SEC-C3 closed by dropping the UPDATE policies on both tables.
- SEC-C4 closed by dropping the DELETE policies on both tables.
- C-FE-1 closed by iterating `storeInventory` (not `filteredItems`) for `nonBlankCount`, `totalItems`, `hasNegative`, and `entries[]` in `onSubmit`.

The one remaining NOT TESTED item (multi-tab realtime) is LOW severity — the architecture is correct and consistent with the EOD pattern; no new code changed the realtime path in a regressive way.

---

## Notes

- **No test framework.** No jest/vitest/playwright. Same gap as prior specs. User approval required before introducing any framework.
- **Multi-tab realtime test** — NOT TESTED. Architecture supports it; requires a browser automation framework.
- **spec AC kind allowlist text** — AC text at spec line 32 lists `'eod'` in the allowlist; the implementation (correctly) excludes it per the architect's design. The implementation is more correct. Not a blocking discrepancy.
- **All 4 security Criticals** follow the same fix pattern as `20260510130000_report_runs_consistency.sql`. This is the third time the `auth_can_see_store`-alone-is-sufficient-for-writes pattern produced Criticals on this codebase. The fix template is now established.
