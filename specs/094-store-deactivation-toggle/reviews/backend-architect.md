# Backend-architect drift review — Spec 083 (store-deactivation-toggle)

Reviewer: backend-architect (post-implementation mode)
Scope: verify the implementation matches the `## Backend design` I authored.
Verdict: **No drift. Zero Critical, zero Should-fix.** Two Minor notes for the
record (neither blocks ship). The four explicit verification points all pass.

---

## Verification against the four named design decisions

### 1. No new migration / RPC / RLS policy — PASS
- No `2026060*` migration exists for spec 083; the latest migrations on disk are
  `20260601000000`, `20260602000000`, `20260602120000` (all spec 093). Confirmed
  via the full `supabase/migrations/*.sql` listing — nothing dated for this spec.
- The server-side gate is the pre-existing `privileged_update_stores` policy
  (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:627-636`),
  USING + WITH CHECK both `auth_is_privileged() AND auth_can_see_brand(brand_id)`
  — exactly as the design relied on. No second permissive policy on
  `(stores, UPDATE)` was introduced, so the CLAUDE.md "permissive policies are
  ORed" footgun is avoided.
- A standalone pgTAP regression pin landed at
  `supabase/tests/stores_privileged_update_status.test.sql` (no migration pairing,
  as designed). Six arms cover admin flip + reverse, master flip, non-privileged
  0-row, cross-brand admin 0-row, and super_admin cross-brand. This is exactly
  the assertion set the design's Tests section recommended. Stronger than the
  "OPTIONAL" bar I set.

### 2. Global `stores` cache stays active-only — PASS (top risk cleared)
This was flagged as the primary review focus (global-cache leakage). Confirmed
clean on every path:
- `src/lib/db.ts:68-82` `fetchStoresIncludingInactive()` returns the array; it
  does NOT call `useStore.setState` / write `s.stores`. The global `fetchStores`
  active-only `.eq('status','active')` filter at `db.ts:49` is UNCHANGED.
- `src/screens/cmd/sections/BrandsSection.tsx`: all three `setStores`
  references (lines 1056, 1064, 1091) are the component-local `React.useState`
  setter (declared `const [stores, setStores] = React.useState<Store[]>([])` at
  1056), not the Zustand global. The include-inactive list lives in tab-local
  state exactly as designed.
- The removed `selStores`/`allStores` plumbing is gone — no
  `useStore((s) => s.stores)` reference remains in the file. `StoresTab` self-
  fetches; the active-only global cache is no longer threaded into it.

### 3. `updateStore` is a partial PostgREST UPDATE; `brand_id` not writable — PASS
- `src/lib/db.ts:91-108`: partial UPDATE, maps only keys present on `updates`
  (`name`/`address`/`eodDeadlineTime`→`eod_deadline_time`/`status`). `brandId`
  is intentionally absent from the mapped keys — matches the design's
  "brand transfer would trip auth_can_see_brand WITH CHECK" rationale.
- Shape mirrors `createStore`/`deleteStore` (`useInflight.getState().track(...)`
  + `kind: 'write'`), as specified.
- `src/store/useStore.ts:1954-1976`: `updateStore` now maps `status` into the
  partial update (closing the documented persistence gap), delegates to
  `db.updateStore` (closing the inline `supabase.from('stores')` carve-out), and
  upgraded to optimistic-then-revert with `notifyBackendError('Update store', e)`
  — snapshots `stores`/`currentStore` and reverts both on failure. This is the
  optimistic-then-revert pattern the design called for; cleaner than the v1 floor
  I set (revert was "optional").

### 4. eod-reminder-cron active-only gate unchanged — PASS
- `supabase/functions/eod-reminder-cron/index.ts:188` still reads
  `.from('stores').select('id, name, eod_deadline_time').eq('status', 'active')`.
  No edit. Both Track 1 (EOD) and Track 2 (vendor) resolve their target store
  from that active-only array, so inactive stores remain suppressed from both
  push and email-fallback streams. `verify_jwt` settings untouched.

---

## Minor (record-only, not blocking)

**M1 — Toast/notifyBackendError split is intentional but worth a one-line note.**
`BrandsSection.tsx:1076` surfaces tab-local *fetch* errors via `Toast.show`,
while *write* errors flow through `useStore.updateStore`'s `notifyBackendError`.
This is correct per the carve-out (`notifyBackendError` is a private store helper
not exported to screens) and the design anticipated screen-level toast. No action;
flagging only so a reviewer doesn't read the two error surfaces as inconsistency.

**M2 — Realtime cross-client staleness is accepted v1 behavior, as designed.**
A status flip from another admin client lands in `useRealtimeSync`'s debounced
`fetchStores` (active-only) and drops the now-inactive row from the global cache,
but does NOT live-update the Stores-tab-local include-inactive list. The tab
reconciles on mount / brand-change / drawer-close (`BrandsSection.tsx:1070-1080`).
This matches the spec's "reflected on the row on next render" criterion and the
design's explicit realtime caveat. No publication membership changed, so the
`docker restart supabase_realtime_imr-inventory` ritual correctly does not apply.
Future enhancement (re-run `fetchStoresIncludingInactive` on the realtime tick)
remains optional, not a v1 gap.

---

## Contract-conformance summary

| Design item | Implemented as designed? |
|---|---|
| No migration / RPC / RLS policy | Yes |
| `privileged_update_stores` reused for the role gate | Yes |
| `db.updateStore` partial PostgREST UPDATE, createStore-shaped | Yes |
| `brandId` not writable in `updateStore` | Yes |
| `fetchStoresIncludingInactive` no status filter, no global-cache write | Yes |
| Global `fetchStores` `.eq('status','active')` unchanged | Yes |
| `useStore.updateStore` maps `status` + delegates to db.ts | Yes |
| Optimistic-then-revert + `notifyBackendError` | Yes (exceeds v1 floor) |
| Inline toggle, confirm-on-deactivate via `confirmAction`, reuse StatusPill | Yes |
| eod-reminder-cron gate unchanged | Yes |
| pgTAP regression pin (optional) | Yes (delivered) |

No call site bypassed `src/lib/db.ts` to hit Supabase directly; the prior inline
`supabase.from('stores').update(...)` carve-out in `useStore` was eliminated.

Note: I did not independently re-run typecheck or the browser click-through; the
frontend-developer reported `tsc --noEmit` clean and a live-REST golden path. The
test-engineer reviewer should confirm the jest/pgTAP suites execute green. This
review is architectural-drift only.
