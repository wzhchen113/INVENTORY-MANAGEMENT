# Spec 171: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-23.
Scope: the staged implementation, compared against `## Backend design` §0–§15 in `specs/171-eod-count-mode.md`.
Method: every file under `## Files changed` was read in its current (staged) state. The RPC body was compared line by line against `supabase/migrations/20260517000000_user_data_i18n_names.sql:135-281`. This agent has no shell, so `git diff --cached` was not run. "Unchanged" claims for out-of-lane files rest on `git status` (for example, `useStore.ts` and `PhoneWeeklyCount.tsx` are not modified) plus reading the current file.

**Verdict: no contract drift.** The implementation matches D1–D8 and §1–§9. There are 0 Critical, 1 Should-fix (a release-gating deploy precondition, not code), and 5 Minor findings.

---

## Contract conformance checklist

| Design item | Result | Evidence |
|---|---|---|
| D1 / §1: additive, idempotent migration; column, default, CHECK, comment | Match | `20261023000000_catalog_eod_count_mode.sql:66-82`. It uses `add column if not exists … not null default 'cases_and_units'`, a drop-then-add CHECK named `catalog_ingredients_eod_count_mode_check` with exactly the three literals, and a column comment that states the mode is inert at `case_qty <= 1` and is never normalized (N2). The whole file is wrapped in `begin; … commit;`. |
| D2 / §3: drop the 12-arg RPC, recreate as 13-arg with `p_eod_count_mode` last | Match | `:85-87` drops the exact 12-arg list. `:89-103` is the 13-arg signature with `p_eod_count_mode text default 'cases_and_units'` last. SECURITY INVOKER and `search_path = public` are preserved. |
| §3 body verbatim except the three planned edits | Match. Diffed against `20260517000000:153-273`. | **Edit 1:** `eod_count_mode` was added to the INSERT column list (`:138`), with value `coalesce(p_eod_count_mode, 'cases_and_units')` (`:146`). **Edit 2:** the `on conflict … do update set updated_at = now()` line (`:155`) is byte-identical; only comment lines were added (`:152-154`). **Edit 3:** `'eod_count_mode', c.eod_count_mode` was added to the `catalog` jsonb (`:225`). Every other executable line matches: validations, the find-or-create select, the `inventory_items` insert with all 12 `p_per_store` coalesces, the `on conflict (store_id, catalog_id) do nothing`, the fallback lookup, and every return key. The only other differences are comment lines (`:198`). |
| §3 grants | Match | `:241-246` does `revoke all … from public, anon` and `grant execute … to authenticated` on the 13-arg list. The developer verified the local ACL as `{postgres=X, authenticated=X, service_role=X}`. pgTAP (21)-(23) pin it. |
| R2: no surviving overload | Match | pgTAP (24) asserts exactly one `pg_proc` row. The developer confirmed with a live PostgREST probe that legacy named-arg calls resolve (no PGRST203). |
| D3 / §2: no RLS or policy change | Match | No policy DDL in the migration. pgTAP (12)-(15) show staff can read the column and that a staff UPDATE affects 0 rows. `permissive_policy_lint` is unaffected. |
| §6 `fetchInventory` embed | Match | `src/lib/db.ts:293` appends `eod_count_mode` to the `catalog:` embed. It is the only `mapItem` source besides the RPC return (`:298`, `:402`). No other `catalog:` embed feeds `mapItem`, so no fetch path silently defaults the mode. |
| §6 `mapItem` | Match | `db.ts:6136` sets `eodCountMode: normalizeEodCountMode(cat.eod_count_mode)`. It is the stored value, not the effective one (N2), and this is pinned in `db.eodCountMode.test.ts:137-145`. |
| §6 `createInventoryItem` | Match | `db.ts:397` sends `p_eod_count_mode: normalizeEodCountMode(item.eodCountMode)`, so only a CHECK-valid literal is ever sent. |
| §6 `updateInventoryItem` | Match | `db.ts:483` follows omit-key-to-skip and rides the single existing `catalog_ingredients` update. It adds no extra round-trip (`db.eodCountMode.test.ts:164-169`). |
| §6 types | Match | `src/types/index.ts:11-12` (`import type` + re-export, the `OrderChannel` precedent). `InventoryItem.eodCountMode?: EodCountMode` (`:196`) is optional as designed. `CatalogIngredient` is untouched. |
| §5 helper surface | Match, byte-for-byte with the pinned signatures | `src/lib/eodCountMode.ts:15-135`. It is dependency-free. `effectiveEodCountMode` guards with `typeof caseQty === 'number' && caseQty > 1`; `mapItem` (`parseFloat`) and the staff fetch (`Number(...)`) both deliver numbers, so the guard never mis-fires on a numeric string. |
| D5: `activeFieldFor` backward compatibility | Match | `src/lib/eodKeypad.ts:60-65`. With one argument it returns `'cases'` iff `typeof caseQty === 'number' && caseQty > 1`, which equals the legacy `(caseQty ?? 0) > 1` for every input including `NaN`. The original describe block at `eodKeypad.test.ts:67-77` is intact, and the new block is separate (`:126+`). `PhoneWeeklyCount.tsx` is not modified (AC-9). |
| D6: `deriveCountedItemIds` | Match | `EODCountSection.tsx:91-125`. The resolver is optional. `!mode \|\| eodBoxes(mode)[box]` reproduces the old result when the resolver is omitted or the id is unknown. Arm (b) is unchanged. The call site passes `(id) => modeById.get(id)`, with `modeById` in the deps (`:636-638`). |
| D7: locked rows use the legacy layout | Match on all four surfaces | Desktop `EODCountSection.tsx:941-944`. Admin phone row `PhoneEodCount.tsx:505-508`. Staff `EODCount.tsx:366-372` (`modeFor` via `inputsLocked`), passed to the row at `:906`. Both keypad sheets use the live mode, which is correct because they only open unlocked (`PhoneKeypadSheet.tsx:67`, `StaffKeypadSheet.tsx:73`). Rest-day is correctly not treated as a lock (`EODCountSection.tsx:941` keys on `isVendorLocked` only). |
| §9 admin `modeById` from `storeInventory` | Match | `EODCountSection.tsx:605-611`. |
| §9 seated-field clamp | Match on both phone surfaces | `PhoneEodCount.tsx:126-139`, `EODCount.tsx:415-440`. `onKey` uses `seatedField`. |
| Staff read path (AC-15) | Match | `EODCount.tsx:160` adds `eod_count_mode` to the existing `item_vendors → inventory_items!inner → catalog_ingredients` embed. `CatalogRow` types it as nullable (`:175`). Fetch-time normalization is at `:209`. The staff subtree is a documented `db.ts` carve-out, so this is not a bypass. |
| §8: `useStore.ts` unchanged | Match | It is not in `git status`. `addItem` (`useStore.ts:2254-2257`) swaps in the RPC result, which now carries `catalog.eod_count_mode`. |
| Editor (AC-17/18) | Match | `IngredientForm.tsx:104` (default), `:118-121` (`parseFloat > 1` visibility), `:1101-1108` (`isEodCountMode` guard on change). Drawer `fromItem`/`toUpdates` at `IngredientFormDrawer.tsx:65,165`. Both hosts (`InventoryCatalogMode.tsx:866,871`) route through the drawer's `updateItem`/`addItem`. The brand-wide fan-out (`:311`) does not need the mode, because the mode is already brand-level through the catalog row. |
| Bypass of `src/lib/db.ts` | None | No admin-side `supabase.from/rpc` was added outside `db.ts`. |
| Edge functions (§4) | None touched | Matches. |
| Realtime (§7) | Match | No publication change. The developer confirmed `catalog_ingredients` UPDATE events carry `eod_count_mode` without `docker restart supabase_realtime_imr-inventory`. |

---

## Critical

None.

---

## Should-fix

### S1. The prod body pre-check (§12 step 2) has not been run, and it is a hard precondition for the prod apply. Ship ordering (D8) depends on it.
- **Where:** spec §12 step 2. The developer's notes ("Not done") confirm it is outstanding.
- **What:** the migration DROPs and recreates `create_inventory_item_with_catalog` from the `20260517000000` body. If prod's live body differs (undeclared dashboard drift), the apply silently overwrites it. Before the MCP apply, the owner or the release run must normalize-md5 prod's `pg_get_functiondef` for the 12-arg signature and compare it to the repo body (project `ebwnovzzkwhsdxkpyjka`, per the project memory procedure).
- **Why it gates release:**
  - Per D8 and R1, the migration must be in prod **before** the push to `main`. Otherwise:
    - Vercel ships a client whose `fetchInventory` embed and staff vendor fetch request a non-existent column. That fails with a 400 and blanks the admin inventory and EOD lists and the staff vendor list.
    - `createInventoryItem` gets `PGRST202`.
    - `db-migrations-applied.yml` goes red.
  - `release-coordinator` should treat "prod md5 pre-check done + MCP apply + `schema_migrations` row `20261023000000` inserted" as a SHIP_READY precondition.
- **Not a code change.**

---

## Minor

### M1. `itemTotal` resolves the mode by a different path than `localHasEntry` and `buildSubmission`.
- `EODCountSection.tsx:619-620`: `itemTotal` calls `effectiveEodCountMode(i.caseQty, i.eodCountMode)` directly.
- `localHasEntry` (`:641`) and `buildSubmission` (`:771`) go through `liveModeById`, which falls back to `'cases_and_units'` for an id that is not in `modeById`.
- Today these never diverge, because `filteredItems` is always a subset of `storeInventory` (`vendorItems` at `:393-401` and the extras at `:569` both derive from it).
- Even so, two resolution paths for one rule is a latent drift surface. Suggest that `itemTotal` use `liveModeById(i.id)` so the total, counted, and entry rules share one lookup.
- No behavior change today.

### M2. The drawer always sends `eodCountMode`, so a stale drawer save is last-writer-wins on a brand-wide field.
- `IngredientFormDrawer.tsx:165` always includes the key, so every edit save writes `catalog_ingredients.eod_count_mode` (through `db.ts:483`).
- If admin A opens the drawer, admin B then changes the mode, and A saves an unrelated field, A's stale mode overwrites B's.
- This is the same class as `name`, `case_qty`, and the other catalog fields, which `toUpdates` already always sends, so it is consistent with the existing pattern and is not drift.
- It is worth noting next to R5/OQ-B (catalog-update errors are swallowed at `db.ts:495-499`). A future "send only dirty catalog fields" pass would fix both.

### M3. AC-4 pgTAP proves visibility with SQL joins rather than the PostgREST embed.
- `eod_count_mode.test.sql:175-195` checks staff read access with plain joins under the staff JWT. That proves the RLS predicate, but not the PostgREST embed resolution.
- The developer's ad-hoc supabase-js probe (staff `manager@local.test` embed returns `eod_count_mode`) closes the gap for this build. `scripts/smoke-staff-eod.sh` still passes.
- Acceptable. A future smoke arm could select `eod_count_mode` through the real embed so the probe isn't one-off.

### M4. Prod post-apply ACL verification should include `service_role`.
- The migration revokes PUBLIC/anon and explicitly grants `authenticated`. `service_role` EXECUTE depends on `ALTER DEFAULT PRIVILEGES` (spec 097) applying to the role that runs the MCP `execute_sql`.
- Nothing in the repo calls this RPC as `service_role`, so this is not functional today.
- Add `select proacl from pg_proc where proname = 'create_inventory_item_with_catalog'` to §12 step 3's verification. Expect `authenticated=X`, no `anon`, and no bare `=X` PUBLIC entry, so prod parity with local (`{postgres=X, authenticated=X, service_role=X}`) is confirmed rather than assumed.

### M5. Informational: accepted residuals behave as designed.
- **Count export** (`EODCountSection.tsx:673-693`) still emits values typed into a now-disabled box. This was accepted under owner decision 3 and is not folded in.
- **The §10.4 draft edge** is present as documented, with arm (b) unchanged:
  1. Save Draft with a cases value.
  2. Realtime flips the item to `units_only`.
  3. Final submit in the same session lets the gate pass while `buildSubmission` omits the item.

  The behavior comes from spec 102 and is out of scope here. A follow-up spec should make arm (b) mode-aware if the owner wants it closed.
- No action is required for this spec.

---

## Notes for release-coordinator

- No contract drift and no RLS gap. No admin-side `db.ts` bypass. The migration body is a faithful copy plus exactly the three planned edits.
- The only release-gating item is **S1**, a deploy-order precondition. Under the CLAUDE.md hard rule, SHIP_READY also requires both `test.yml` and `db-migrations-applied.yml` to be green on `main` after the push. The second gate goes green only if the prod apply happens first.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (S1, prod md5 pre-check + apply-before-push precondition), 5 Minor.
payload_paths:
  - specs/171-eod-count-mode/reviews/backend-architect.md
