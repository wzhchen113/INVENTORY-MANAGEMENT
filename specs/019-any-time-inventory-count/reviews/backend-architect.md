# Backend architect drift review — Spec 019 (Any-time inventory count)

Mode: post-implementation review.
Scope: design adherence on 8 files listed in the dispatch prompt.
Verdict: **APPROVE** — zero Drift, zero Critical or Should-fix findings.

## Drift inventory

### 1. Schema (`supabase/migrations/20260513000000_inventory_counts.sql`)

| Surface | Designed | Implemented | Verdict |
|---|---|---|---|
| Filename + ordering | `20260513000000_inventory_counts.sql` after `20260512120000_report_run_variance.sql` | Same — confirmed by `Glob` listing | **Faithful** |
| `inventory_counts.id` | `uuid pk default gen_random_uuid()` | Line 71 — identical | **Faithful** |
| `inventory_counts.store_id` | `uuid not null references stores(id) on delete cascade` | Line 72 — identical | **Faithful** |
| `inventory_counts.counted_at` | `timestamptz not null default now()` | Line 73 — identical | **Faithful** |
| `inventory_counts.kind` | `text not null check (kind in ('spot','open','mid_shift','close'))` | Lines 74-75 — identical; `'eod'` excluded as designed | **Faithful** |
| `inventory_counts.submitted_by` | `uuid null references profiles(id) on delete set null` | Line 76 — identical | **Faithful** |
| `inventory_counts.submitted_at` | `timestamptz not null default now()` | Line 77 — identical | **Faithful** |
| `inventory_counts.status` | `text not null default 'submitted' check (status in ('draft','submitted'))` | Lines 78-79 — identical | **Faithful** |
| `inventory_counts.client_uuid` | `uuid null` | Line 80 — identical | **Faithful** |
| `inventory_counts.notes` + `created_at` | both as designed | Lines 81-82 — identical | **Faithful** |
| Index `(store_id, counted_at desc)` | named `inventory_counts_store_counted_at_idx` | Lines 87-88 — identical | **Faithful** |
| Index `(store_id, kind, counted_at desc)` | named `inventory_counts_store_kind_counted_at_idx` | Lines 93-94 — identical | **Faithful** |
| Partial unique on `client_uuid` | `where client_uuid is not null` | Lines 97-99 — identical | **Faithful** |
| `inventory_count_entries.id`/`count_id`/`item_id` | as designed; `count_id` cascade, `item_id` RESTRICT | Lines 105-107 — identical | **Faithful** |
| `actual_remaining` / `actual_remaining_cases` / `actual_remaining_each` | `numeric(10,3) null` × 3 | Lines 108-110 — identical | **Faithful** |
| `inventory_count_entries.unit/notes/created_at` | as designed | Lines 111-113 — identical | **Faithful** |
| Index `(count_id)` | `inventory_count_entries_count_id_idx` | Lines 117-118 — identical | **Faithful** |
| Index `(item_id, created_at desc)` | `inventory_count_entries_item_created_idx` | Lines 122-123 — identical | **Faithful** |
| RLS enabled on both tables | yes | Lines 101, 125 | **Faithful** |
| 4 policies × 2 tables, parent via `auth_can_see_store(store_id)`, child via `EXISTS` join | as designed | Lines 134-206 — `drop policy if exists` preludes match `per_store_rls_hardening` housekeeping convention | **Faithful** |

No additional columns, no missing columns, no FK posture drift. Indexes match the design 1:1.

### 2. RPC contract (`public.submit_inventory_count`)

| Property | Designed | Implemented | Verdict |
|---|---|---|---|
| Signature | `(p_client_uuid uuid, p_store_id uuid, p_kind text, p_counted_at timestamptz, p_status text, p_entries jsonb, p_notes text) returns jsonb` | Lines 226-234 — exact match | **Faithful** |
| `language plpgsql` / `security invoker` / `set search_path = public` | as designed | Lines 235-237 — all three present | **Faithful** |
| Auth gate FIRST → `42501` | `if not auth_can_see_store(p_store_id) then raise 42501` | Lines 247-251 — identical | **Faithful** |
| Kind allowlist → `22023`; `'eod'` rejected | as designed | Lines 257-259 — identical; CHECK on column is the backstop | **Faithful** |
| Status allowlist → `22023` | `coalesce(p_status, 'submitted') not in ('draft','submitted')` | Lines 262-264 — identical | **Faithful** |
| `p_entries` is non-empty array → `22023` | jsonb_typeof + array_length | Lines 268-272 — identical | **Faithful** |
| Idempotency: `client_uuid` lookup BEFORE parent insert; conflict returns `{count_id, conflict:true, entry_ids:[]}` | as designed | Lines 274-286 — identical to `staff_submit_eod` shape | **Faithful** |
| Parent insert with `submitted_by := auth.uid()` (server-canonical) | as designed | Lines 290-300 — `auth.uid()` is hard-wired in the VALUES clause; the RPC signature has no `p_submitted_by` parameter, so the client cannot forge attribution at all | **Faithful** |
| `jsonb_to_recordset` walk; SKIP fully-blank rows | as designed | Lines 305-320 — identical; `continue` on `actual_remaining is null AND cases is null AND each is null` | **Faithful** |
| Per-entry `>= 0` check → `22023` | as designed | Lines 323-327 — `coalesce(..., 0) < 0` on all three numeric columns | **Faithful** |
| `item_id` belongs to `p_store_id` → `23503` | exists-check against `inventory_items` | Lines 333-339 — identical | **Faithful** |
| `≥ 1 non-blank entry` final guard → `22023` | as designed | Lines 357-359 — exact wording from design | **Faithful** |
| Return shape | `jsonb_build_object('count_id', 'conflict', 'entry_ids')` | Lines 361-365 — identical | **Faithful** |
| `REVOKE EXECUTE FROM public, anon; GRANT TO authenticated` | as designed | Lines 373-374 — identical to `report_runs.sql:205-211` pattern | **Faithful** |

### 3. `current_stock` untouched — CONFIRMED

`Grep` for `current_stock|eod_remaining|UPDATE inventory_items|update inventory_items` against the migration returns only two hits, both in the design-rationale comment block at lines 56-61 (which explicitly states the RPC does NOT write `inventory_items.current_stock`). No executable SQL statement in the file references `inventory_items` for write — only the `exists` read in the per-entry validator at lines 333-339. This is the load-bearing contract per Q2 and is intact.

Backend developer's verification notes (spec lines 1012-1014) corroborate: after 11 smoke tests, `inventory_items.current_stock` row state was unchanged, and `eod_submissions`/`eod_entries` counts were unchanged.

### 4. No variance-anchor change — CONFIRMED

`Grep` for `report_run_variance|variance` against the migration returns only two hits, both in the design-rationale comments (lines 10, 91), explaining why the new tables are parallel and why the second index supports a possible future variance-anchor flip. `20260512120000_report_run_variance.sql` is not modified — `git status` at the head of this conversation shows only ADD operations on spec 019 files and no modifications to the variance migration. Q3 is intact.

### 5. `db.ts` and store contract

| Surface | Designed | Implemented | Verdict |
|---|---|---|---|
| `submitInventoryCount(input)` return shape | `{ countId, conflict, entryIds }` | `src/lib/db.ts:641-683` — exact match including `clientUuid` parameter (camelCase → `p_client_uuid` snake_case) and per-entry mapping | **Faithful** |
| `fetchRecentInventoryCounts(storeId, limit?)` | PostgREST embed with `inventory_count_entries(count)` aggregate + `submitter:profiles!submitted_by(name)` | `src/lib/db.ts:691-725` — exact embed; defensively handles both `[{count}]` array and `{count}` object aggregate shapes | **Faithful** |
| `fetchInventoryCount(countId)` | PostgREST embed with `item:inventory_items(catalog:catalog_ingredients(name, unit))` | `src/lib/db.ts:732-778` — exact embed; matches the EOD detail pattern at `db.ts:506` | **Faithful** |
| Types `InventoryCountKind` / `InventoryCountEntry` / `InventoryCount` / `InventoryCountSummary` | exact field set | `src/types/index.ts:249-289` — all four types match the design's field-by-field shape including hydrated `submitterName` and derived `itemCount` | **Faithful** |
| Store action `submitInventoryCount` — mints `client_uuid` internally, routes errors through `notifyBackendError`, no persistent slice | as designed | `src/store/useStore.ts:1421-1451` — uses `crypto.randomUUID()` with a degraded-environment fallback, routes through `notifyBackendError('Submit inventory count', e)`, returns `{ countId, conflict } \| null`, mutates no state slice | **Faithful** |
| Type import path | `InventoryCountKind` from `../types` | `useStore.ts:8-9` — imported from `'../types'` alongside `Brand` | **Faithful** |

### 6. Cmd UI integration

| Surface | Designed | Implemented | Verdict |
|---|---|---|---|
| Sidebar entry "Inventory count" in `Operations` group, immediately after `EOD count` | as designed | `cmdSelectors.ts:1039-1042` — placed exactly after `EODCount`, label "Inventory count" | **Faithful** |
| `SCREEN_ENTRIES` palette entry | as designed | `cmdSelectors.ts:162-163` — `{ name: 'InventoryCount', label: 'Inventory count' }` immediately after `EODCount` | **Faithful** |
| Dispatch arm in `InventoryDesktopLayout.tsx` | new `else if (section === 'InventoryCount')` arm immediately after `EODCount` | Lines 158-161 — exact placement | **Faithful** |
| Import statement | `import InventoryCountSection from './sections/InventoryCountSection'` after `EODCountSection` | Line 34 — exact | **Faithful** |
| Realtime channel — `inventory_counts` on the per-store channel filtered by `store_id` | as designed | `useRealtimeSync.ts:37-40` — added with the same `store_id=eq.${storeId}` filter shape as `eod_submissions`. Entries table intentionally NOT on the channel (mirrors EOD's parent-only subscription, exactly per design §7) | **Faithful** |
| Section-owned realtime subscription (architect §7 Option A) | section subscribes on its own `inv-count-section-${storeId}` channel and bumps `refreshTick` | `InventoryCountSection.tsx:181-194` — exact pattern. Two channel subscriptions on `inventory_counts` is mildly redundant but harmless: the global hook triggers `loadFromSupabase` (a no-op for counts) and the section-local hook drives the recent-list refetch. Both were called out as acceptable in the design | **Faithful** |

### 7. Cross-cut spot checks

- **Brand-catalog refactor compatibility.** The detail embed uses `item:inventory_items(catalog:catalog_ingredients(name, unit))` (db.ts:742). Post-P3, `inventory_items.catalog_id` is `NOT NULL` (per `20260504072830_brand_catalog_p3_lockdown.sql:23`), so the `e.item?.catalog?.name || ''` fallback in `db.ts:769` is defensive but never null-path in practice. Matches existing EOD entry-detail shape exactly.
- **Section's `submitterName` resolution.** `db.ts:715` uses `row.submitter?.name`. PostgREST embed returns either an object or null depending on whether the `submitted_by` FK is populated. The architect's design specified hydration via the `name` column — confirmed.
- **Spec's "Files changed" matches reality.** All eight files listed for inspection are present and modified, plus `InventoryCountSection.tsx` was added as a new file. `git status` shows only ADDed reviewer stubs and the new spec + migration + section files alongside the listed edits — no surprise edits to unrelated tables.
- **No `useSupabaseStore.ts` or `AdminScreens.tsx` touched.** Spot-checked via `Grep` — both legacy stores are untouched, honoring the CLAUDE.md "Legacy admin screens" and "Data layer (active vs. legacy)" rules.

## Forward-compatibility notes (don't redesign — flagging for the next spec author)

### Staff app integration (Q4 deferred)

When staff need to submit any-time counts from the separate staff-app repo, the path is symmetric with how EOD is split:

1. **New RPC** `public.staff_submit_inventory_count(...)` — same parameter list as `submit_inventory_count` plus an explicit `p_submitted_by_user_id uuid` (because the staff edge function authenticates via service-token, not a Supabase JWT, so `auth.uid()` would be NULL inside the body).
2. **`security definer`** + locked to `service_role` — mirrors `staff_submit_eod` at `20260504000001_staff_submit_eod_rpc.sql`.
3. **New edge function** `supabase/functions/staff-submit-inventory-count/` with `verify_jwt = false` in `supabase/config.toml`, validating the service-token bearer header itself (same shape as `staff-submit-eod`).
4. **`p_submitted_by_user_id` validation** inside the definer body — verify the supplied profile id has `store_id = p_store_id` membership before honoring it. The existing admin-invoker RPC already short-circuits on `auth.uid()` so no change there.

That stays a separate spec and a separate repo touch. Nothing in spec 019 blocks it.

### Variance-anchor flexibility (Q3 deferred)

If a future spec wants variance to anchor on a spot/open/mid_shift/close count instead of EOD, the migration shape is additive:

1. **Extend** the variance RPC (`run_report_variance` in `20260512120000_report_run_variance.sql`) with a new optional parameter `p_anchor_kind text default 'eod'`. When `'eod'`, behaviour is unchanged. When `'spot' | 'open' | 'mid_shift' | 'close' | 'any'`, the inner query selects from `inventory_counts` + `inventory_count_entries` joined on the same `(store_id, item_id)` keying.
2. **Existing index** `inventory_counts_store_kind_counted_at_idx` already supports this lookup at no migration cost — the architect added it explicitly with this in mind (see migration line 90-94 comment).
3. **UX** would need the user to pick a count by timestamp + kind rather than a date — that's the only non-trivial UI cost.
4. **No data backfill** required. `inventory_counts` is purely additive; the variance helper just gains a new source.

This is a forward-compatible shape only — does not retroactively constrain spec 019.

## Block recommendation

**No block.** Implementation is faithful to the design across all five contract surfaces inspected. The two load-bearing invariants (no `current_stock` write per Q2, no variance-anchor change per Q3) are intact and corroborated by the developer's smoke-test log in the spec's verification section. The two acknowledged tradeoffs (browser preview not performed; per-entry RPC loop not batched) are surfaced in the developer's verification notes already and are out of scope to redo.

Outstanding non-blocking observations for downstream reviewers:

- The frontend developer flagged that browser preview was not performed (spec lines 1098-1106). That is a test-engineer / manual-QA concern, not an architectural one — the static checks (typecheck, bundle compile, token grep) are sufficient to attest the wiring landed.
- The section subscribes to `inventory_counts` realtime events both via the global `useRealtimeSync` hook AND via its own `inv-count-section-${storeId}` channel. This was anticipated and approved in the architect's design (§7 Option A explicitly chose section-local subscription for the section refetch; the global hook entry was added so the standard 400 ms debounced `loadFromSupabase` also fires, even though that reload is a no-op for counts). Harmless; flagged for awareness only.
