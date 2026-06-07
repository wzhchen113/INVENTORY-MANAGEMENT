# Spec 094: Store deactivation toggle (suppress notifications for non-operational stores)

> Renumbered from 083 → 094: spec number 083 was already taken by an unrelated shipped commit ("Fix (email not loaded)").

Status: READY_FOR_REVIEW

## User story
As a store-management admin (admin / master / super_admin), I want to mark a
store as inactive when it is not operating or has stopped operations, so that
the store stops receiving future reminder notifications and is clearly shown as
INACTIVE in the admin store list — without deleting the store or any of its
historical data, and so that I can re-activate it later.

## Decisions (from resolved open questions)
- **Scope of effect = "Notifications + list flag" only.** Deactivating suppresses
  store-tied notifications AND shows an INACTIVE badge in the admin store list.
  The store keeps working everywhere else (EOD counts, reorder, reports, staff
  store picker). This is explicitly NOT a full disable.
- **Notification streams = ALL of them; `status='inactive'` is the single
  canonical suppression gate** for every store-tied notification stream, now and
  going forward. Both existing cron tracks already gate on `status='active'`, so
  the existing gate satisfies this for today's streams (see Acceptance criteria
  and Project-specific notes).
- **Permissions = `admin + master + super_admin`** (matches
  `auth_is_privileged()` / the edge-function `ADMIN_ROLES` set), enforced
  server-side.
- **UI = inline toggle on each store row** in Brands > Stores, with a confirm
  dialog, reversible, all data preserved, reusing the existing ACTIVE/INACTIVE
  `StatusPill`.
- **`fetchStores` = lowest-blast-radius.** Do NOT relax the global
  `fetchStores` `.eq('status','active')` filter that many call sites depend on.
  Add a separate include-inactive fetch path for the admin Stores tab only.

## Context discovered during PM investigation
- `public.stores.status` already exists with values `'active' | 'inactive'`
  (default `'active'`) — [supabase/migrations/20260405000759_init_schema.sql:14](../supabase/migrations/20260405000759_init_schema.sql).
  The `Store` TS type already carries `status: 'active' | 'inactive'`
  ([src/types/index.ts:463](../src/types/index.ts)).
- The EOD reminder cron ALREADY filters to active stores:
  `sb.from('stores').select(...).eq('status', 'active')`
  ([supabase/functions/eod-reminder-cron/index.ts:188](../supabase/functions/eod-reminder-cron/index.ts)).
  Track 1 (EOD count reminders) and Track 2 (vendor order-cutoff reminders)
  both resolve the store from that active-only array, so an inactive store
  is already suppressed from BOTH push and email-fallback reminders today.
- **No other store-tied notification path exists today.** The only edge
  functions referencing notifications/push/reminders are `eod-reminder-cron`
  (both tracks gated above), `breadbot-nightly-sync`, and
  `fetch-breadbot-sales`. The breadbot functions do NOT emit store-tied
  notifications — their `from('stores')` use is a name→id lookup
  ([supabase/functions/breadbot-nightly-sync/index.ts:267](../supabase/functions/breadbot-nightly-sync/index.ts)),
  not a notification gate. => `eod-reminder-cron` is the only stream and it is
  already gated. No non-cron notification path needs a new gate today.
- There is NO way to set `status` from the app today:
  - `useStore.updateStore` only writes `name`, `address`, `eod_deadline_time`
    — it does NOT include `status` in `dbUpdates`
    ([src/store/useStore.ts:1961-1964](../src/store/useStore.ts)). This is the
    persistence gap to fill.
  - There is no `updateStore` in [src/lib/db.ts](../src/lib/db.ts) (only
    `createStore` / `deleteStore` / `fetchStores`).
  - The store-create UI (`StoreFormDrawer`) hardcodes `status: 'active'` and
    has no edit mode ([src/components/cmd/StoreFormDrawer.tsx:49](../src/components/cmd/StoreFormDrawer.tsx)).
- `fetchStores` filters `.eq('status', 'active')`
  ([src/lib/db.ts:44-58](../src/lib/db.ts)) and populates the GLOBAL `stores`
  cache in the Zustand store ([src/store/useStore.ts:570-577](../src/store/useStore.ts),
  [src/store/useStore.ts:965](../src/store/useStore.ts)). That cache is consumed
  widely (current-store resolution, store picker, reports). Relaxing this filter
  globally is high blast radius — hence the separate include-inactive path
  decision above.
- The Brands > Stores tab (`StoresTab`) renders an ACTIVE/INACTIVE `StatusPill`
  per row ([src/screens/cmd/sections/BrandsSection.tsx:1123-1126](../src/screens/cmd/sections/BrandsSection.tsx)),
  but the INACTIVE branch is currently dead code because the source list comes
  from the active-only global cache (`StoresTab` receives `selStores` derived
  from `useStore((s) => s.stores)` at
  [src/screens/cmd/sections/BrandsSection.tsx:69](../src/screens/cmd/sections/BrandsSection.tsx)).
- Stores are managed in the Brands section's `StoresTab` (read-only list +
  "+ NEW STORE" drawer). There is no per-store edit affordance today.

## Acceptance criteria
- [ ] An authorized admin (`admin` / `master` / `super_admin`) can toggle a
      store between `active` and `inactive` from an inline control on each store
      row in Brands > Stores (`StoresTab`,
      [src/screens/cmd/sections/BrandsSection.tsx](../src/screens/cmd/sections/BrandsSection.tsx)).
      The toggle persists `stores.status` and the new value is reflected on the
      row on next render.
- [ ] Toggling to `inactive` shows a confirm dialog before persisting (use the
      cross-platform `confirmAction` at [src/utils/confirmAction.ts](../src/utils/confirmAction.ts));
      re-activating MAY skip the confirm (re-activation is non-destructive).
- [ ] The status change persists via the standard db.ts path: a new
      `db.ts` `updateStore` (or extension of the existing store-update path) that
      writes `stores.status`, AND `useStore.updateStore` is extended to include
      `status` in `dbUpdates` (currently omitted —
      [src/store/useStore.ts:1961-1964](../src/store/useStore.ts)).
- [ ] The admin Brands > Stores list shows BOTH active and inactive stores, each
      with the correct ACTIVE/INACTIVE `StatusPill`, via a separate
      include-inactive fetch path (e.g. a new `fetchStoresIncludingInactive()`
      in db.ts, or an opt-in `{ includeInactive: true }` param). The existing
      global `fetchStores` `.eq('status','active')` filter
      ([src/lib/db.ts:49](../src/lib/db.ts)) is UNCHANGED and the global `stores`
      cache that other call sites rely on remains active-only.
- [ ] Setting a store `inactive` suppresses ALL store-tied notification streams.
      Concretely: the existing `eod-reminder-cron` gate
      (`.eq('status','active')`, [supabase/functions/eod-reminder-cron/index.ts:188](../supabase/functions/eod-reminder-cron/index.ts))
      already suppresses Track 1 (EOD count reminders) and Track 2 (vendor
      order-cutoff reminders) for inactive stores; this criterion is to
      confirm/preserve that gate, NOT to add or regress it. No code change to the
      cron is required for today's streams.
- [ ] The toggle is reversible: re-activating sets `status='active'` and the
      store resumes receiving notifications on the next cron run.
- [ ] No store data is deleted by deactivation — inventory, recipes, EOD
      history, sales, etc. are preserved (only `stores.status` changes).
- [ ] The status update is gated to `admin` / `master` / `super_admin`
      server-side (RLS policy and/or RPC mirroring `auth_is_privileged()`), not
      UI-only. A non-privileged caller's status update is rejected by the
      backend.

## In scope
- An inline per-row toggle in Brands > Stores (`StoresTab`) to set
  `stores.status` to `'active'` / `'inactive'`, with a confirm-on-deactivate
  dialog, reusing the existing ACTIVE/INACTIVE `StatusPill`.
- Persisting the status change through the standard db.ts path (add a `status`
  write path; extend `useStore.updateStore` to include `status`).
- A separate include-inactive fetch path so the admin Stores tab can render
  inactive stores; the global `fetchStores`/`stores` cache stays active-only.
- Server-side enforcement of the `admin/master/super_admin` role gate on the
  status update (RLS policy and/or RPC).
- Confirming (not changing) the existing `eod-reminder-cron` active-store gate
  as the canonical suppression for all store-tied notifications.

## Out of scope (explicitly)
- **Full disable.** Hiding/disabling inactive stores from EOD counts, reorder,
  reports, or the staff store picker. Rationale: user chose "Notifications +
  list flag"; full disable is a much larger blast radius (RLS + many screens).
- Relaxing the global `fetchStores` `.eq('status','active')` filter or the
  global `stores` cache. Rationale: many call sites depend on active-only;
  lowest-blast-radius is a separate include-inactive path.
- Deleting stores or any store data — deactivation is non-destructive. Permanent
  removal stays on the existing `deleteStore` path.
- The customer PWA and any sibling apps — this is the admin/staff repo only.
- Changing the `app.json` slug — unrelated and load-bearing (CLAUDE.md).
- Reworking the notification cron's bucket/dedup logic — only the existing
  active-store gate is relevant here, and it is already in place.
- Adding new notification streams or gating breadbot sync — breadbot emits no
  store-tied notifications today; nothing to gate.

## Open questions resolved
- Q1 (Scope of effect) → A: "Notifications + list flag" only — suppress
  notifications AND show an INACTIVE badge in the admin store list; store keeps
  working everywhere else. Not a full disable.
- Q2 (Which notification streams) → A: ALL store-tied streams, with
  `status='inactive'` as the single canonical suppression gate now and going
  forward. Both cron tracks already filter to active stores, so the existing
  gate satisfies this; PM investigation found no non-cron store-tied
  notification path that still needs gating.
- Q3 (Permissions) → A: `admin + master + super_admin` (matches
  `auth_is_privileged()`).
- Q4 (UI placement + reversibility) → A: Inline toggle on each store row in
  Brands > Stores with a confirm dialog; reversible; all data preserved; reuse
  the existing ACTIVE/INACTIVE pill in `BrandsSection.tsx`.
- Q5 (`fetchStores` behavior) → A: Do NOT relax the global active-only filter;
  add a separate include-inactive fetch path for the admin Stores tab only.

## Dependencies
- `public.stores.status` column (already exists — no migration for the column).
- `eod-reminder-cron` edge function (already gates on `status='active'`; no code
  change expected — confirmation only).
- A store-update path in `db.ts` that writes `status` (new), plus extending
  `useStore.updateStore` to include `status` in `dbUpdates`
  ([src/store/useStore.ts:1961-1964](../src/store/useStore.ts)).
- A new include-inactive fetch path in `db.ts` for the admin Stores tab.
- RLS policy and/or RPC to enforce the `admin/master/super_admin` gate on the
  status update server-side (architect to decide RLS-policy vs RPC).

## Project-specific notes
- Cmd UI section / legacy: Cmd UI — Brands section, `StoresTab`
  ([src/screens/cmd/sections/BrandsSection.tsx](../src/screens/cmd/sections/BrandsSection.tsx))
  and (for reference) `StoreFormDrawer`
  ([src/components/cmd/StoreFormDrawer.tsx](../src/components/cmd/StoreFormDrawer.tsx)).
  No legacy surface (spec 025 deleted it).
- Per-store or admin-global: per-store data; the toggle is a privileged admin
  action on a single store. Respect per-store RLS / `auth_can_see_store()` plus
  the `admin/master/super_admin` gate.
- Realtime channels touched: store rows publish on `store-{id}` (and brand
  rollups on `brand-{id}`). If the inactive flag should propagate live to other
  admin clients, name the channel during arch. RISK: mid-session realtime
  publication changes need a `docker restart supabase_realtime_imr-inventory`
  to re-snapshot the slot (project realtime gotcha) — flag if the publication
  set changes.
- Migrations needed: NO for the column (it exists). LIKELY YES if the role gate
  requires a new/updated RLS policy or a new RPC for the status update — pgTAP
  track if so.
- Edge functions touched: `eod-reminder-cron` — confirm only; the existing
  `.eq('status','active')` gate covers all store-tied streams. No code change
  expected.
- Web/native scope: admin Cmd UI control — web + native admin surface. No
  web-only APIs involved.
- Tests (spec 022 tracks): jest for the inline toggle UI + the `useStore`
  status write + the include-inactive fetch path; pgTAP if a new RLS policy /
  RPC lands (assert non-privileged status update is rejected, privileged is
  allowed); shell smoke optional to confirm the cron active-store gate.

---

## Backend design

### TL;DR — headline decisions

1. **No migration. No new RPC. No new RLS policy.** The server-side role gate the
   spec asks for *already exists*: `privileged_update_stores` on `public.stores`
   ([supabase/migrations/20260509000000_multi_brand_schema_rls.sql:627-636](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
   gates UPDATE on `auth_is_privileged() AND auth_can_see_brand(brand_id)` for
   both USING and WITH CHECK. `auth_is_privileged()` is exactly the
   `admin + master + super_admin` set the spec wants (Q3). A status-only PATCH
   passes WITH CHECK because `brand_id` is unchanged. This is the entire
   server-side enforcement story — the feature is a pure client-layer wiring job.
2. **The status write is a plain PostgREST UPDATE through a new `db.ts`
   `updateStore`** — not an RPC. Justification below.
3. **A separate `fetchStoresIncludingInactive()` in `db.ts`** feeds the admin
   Stores tab only and does NOT touch the global `stores` cache.
4. **`eod-reminder-cron` is confirmed unchanged.** Its `.eq('status','active')`
   gate at line 188 is the single canonical suppression and it already covers
   both Track 1 (EOD) and Track 2 (vendor). No code change. See "Edge function
   changes".

### Data model changes

**None.** `public.stores.status text default 'active'` already exists
([init_schema.sql:14](../supabase/migrations/20260405000759_init_schema.sql)).
No new tables, columns, or indexes. No backfill. No `supabase/migrations/*.sql`
file is authored for this spec.

> Note for the developer: do NOT add a migration "for completeness." Adding a
> redundant RLS policy on `(stores, UPDATE)` would create a SECOND permissive
> policy on the same `(table, command)` pair, which Postgres ORs together —
> directly hitting the CLAUDE.md "permissive policies are ORed" footgun and
> potentially widening the gate. Leave the existing policy alone.

### RLS impact

**No policy changes.** The relevant existing policies, confirmed in place:

| Table | Command | Policy | Helper | Effect on this spec |
|-------|---------|--------|--------|---------------------|
| `public.stores` | UPDATE | `privileged_update_stores` | `auth_is_privileged() AND auth_can_see_brand(brand_id)` | Enforces the Q3 role gate on the status write. A non-privileged caller's PATCH returns 0 rows (RLS filters it) — the criterion "rejected by the backend" is met. |
| `public.stores` | SELECT | `store_member_read_stores` | `auth_can_see_store(id)` | Governs BOTH `fetchStores` and the new include-inactive read. An admin/master/super_admin sees all stores in their brand regardless of status (status is not in the SELECT policy), so `fetchStoresIncludingInactive()` returns inactive rows for privileged callers. |

**Verified non-issues:**
- The legacy wide `auth_manage_stores` policy was already dropped in spec 051
  ([legacy_permissive_policy_dropout.sql:81](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)),
  so there is no OR-tail neutralizing the scoped UPDATE policy. The
  permissive-policy lint ([permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql))
  stays green because we add no policy.

### API contract

**PostgREST, not RPC** — for both the write and the include-inactive read.

Rationale for choosing PostgREST over an RPC:
- The role gate is already enforced declaratively by `privileged_update_stores`.
  An RPC would *duplicate* that gate with an inline `if not auth_is_privileged()`
  check, creating two sources of truth for the same authorization decision.
- The RPC precedents in this repo (`demote_profile_to_user`,
  `assert_not_last_of_role`, the report runners) exist because they need
  *imperative* logic RLS can't express: self-guards, last-of-role guards,
  multi-step transactions, or SECURITY DEFINER privilege elevation. A
  single-column status flip on a table that already has a correct UPDATE policy
  needs none of that. This matches how `createStore`/`deleteStore` already work
  in `db.ts` — plain `supabase.from('stores')` calls, no RPC.
- No self-guard / last-of-role concern applies: deactivating a store is
  reversible and non-destructive (the spec's whole premise), so the CLAUDE.md
  destructive-op guards do not extend here.

**Write contract** (status toggle and any other store field edit):

- Request: `PATCH /rest/v1/stores?id=eq.<uuid>` with a partial body, e.g.
  `{ "status": "inactive" }` (or `{ "name": ... }`, `{ "address": ... }`,
  `{ "eod_deadline_time": ... }`).
- Response: the updated row(s). 0 rows when RLS filters out a non-privileged or
  cross-brand caller — treat 0-row as a silent no-op at the client (the
  optimistic value will be corrected on the next `fetchStoresIncludingInactive`).
- Error cases: RLS denial surfaces as a successful 2xx with an empty result set
  (PostgREST UPDATE semantics), NOT a 4xx — so the client must not assume
  "no error thrown == persisted." For the toggle this is acceptable because the
  Stores tab re-fetches; a hard-confirm is not required.

**Include-inactive read contract:**

- Request: `GET /rest/v1/stores?select=*` with NO `status` filter.
- RLS still scopes rows to the caller's brand via `store_member_read_stores`.
- Response: all stores (active + inactive) the caller may see.

### Edge function changes

**None.** `verify_jwt` settings unchanged for every function.

Confirmation (acceptance criterion, not a change):
`eod-reminder-cron/index.ts:187-188` reads
`sb.from('stores').select('id, name, eod_deadline_time').eq('status','active')`.
Both Track 1 (EOD count reminders) and Track 2 (vendor order-cutoff reminders)
resolve their target store from that active-only array, so flipping a store to
`inactive` removes it from BOTH push and email-fallback streams on the next cron
run. Re-activating restores it on the following run. The developer MUST NOT edit
this gate; the test surface should pin it (see Tests).

### `src/lib/db.ts` surface

Two new exports in the `// ─── STORES ───` block, following the existing
`fetchStores`/`createStore` shape (the `useInflight.getState().track(...)`
wrapper + inline snake_case→camelCase mapping; reuse the exact field map already
in `fetchStores` at [db.ts:52-57](../src/lib/db.ts)).

```ts
// New: include-inactive read for the admin Stores tab ONLY.
// Identical projection/mapping to fetchStores, MINUS the .eq('status','active').
// Does NOT write the global `stores` cache — caller holds the result in
// StoresTab-local state.
export async function fetchStoresIncludingInactive(): Promise<Store[]>;

// New: status (and general store field) write. Partial update; only maps the
// keys present on `updates`, same defensive pattern as useStore.updateStore's
// current dbUpdates builder. snake_case mapping:
//   name → name, address → address,
//   eodDeadlineTime → eod_deadline_time, status → status, brandId → brand_id.
// brandId is intentionally NOT writable here (would trip auth_can_see_brand
// WITH CHECK on a brand transfer); omit it from the mapped keys.
export async function updateStore(
  id: string,
  updates: Partial<Pick<Store, 'name' | 'address' | 'eodDeadlineTime' | 'status'>>,
): Promise<void>;
```

`updateStore` replaces the inline `supabase.from('stores').update(...)` currently
living in `useStore.updateStore` ([useStore.ts:1959-1969](../src/store/useStore.ts)).
That inline call is a pre-existing carve-out violation of the "all DB traffic
through db.ts" rule; this spec is the natural moment to close it, and the
acceptance criteria explicitly call for a `db.ts` `updateStore`. The new helper
is the single write path for all four fields, so `name`/`address`/
`eodDeadlineTime` edits also start flowing through db.ts — a strict improvement,
no behavior change for those fields.

### Realtime impact

`stores` rows replay on the **`store-{id}`** channel
([useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts)). `supabase_realtime` is
`FOR ALL TABLES` (see [inventory_counts.sql:63-64](../supabase/migrations/20260513000000_inventory_counts.sql)
and the spec-004 publication migration), so `stores` is already published.

**No publication membership change → the `docker restart
supabase_realtime_imr-inventory` ritual does NOT apply to this spec.** Flagged
explicitly per the CLAUDE.md realtime gotcha: there is nothing to re-snapshot.

Caveat the developer should know but need not act on: the admin Stores tab reads
from `fetchStoresIncludingInactive()` into tab-local state, NOT the global
`stores` cache that `useRealtimeSync` refreshes. So a status flip from ANOTHER
admin client will land in the realtime debounced reload's `fetchStores` (active-
only) and silently drop the now-inactive row from the global cache, but it will
NOT live-update the Stores-tab-local include-inactive list. That is acceptable
for v1 (matches the spec's "reflected on the row on next render" criterion — the
tab re-fetches on mount/focus). If live cross-client sync of the inactive list
is later wanted, the Stores tab would re-run `fetchStoresIncludingInactive` on
the same realtime tick — call it out as a future enhancement, not a v1 gap.

### Frontend store impact

Slice: the **Stores** block of [src/store/useStore.ts](../src/store/useStore.ts)
(`addStore` / `updateStore`, ~lines 1945-1970).

1. `updateStore` ([useStore.ts:1954-1970](../src/store/useStore.ts)) changes:
   - Add `if (updates.status !== undefined) dbUpdates.status = updates.status;`
     to the `dbUpdates` builder (the documented persistence gap at lines
     1961-1964).
   - Replace the inline `supabase.from('stores').update(dbUpdates).eq('id', id)`
     with a call to the new `db.updateStore(id, updates)`. Keep the existing
     optimistic `set(...)` that updates both `stores` and `currentStore` — this
     is the established optimistic-then-revert shape. On the db call's `.catch`,
     follow the existing pattern; `notifyBackendError('Update store', e)` is the
     right surface here (the current code only `console.warn`s — upgrading to
     `notifyBackendError` is consistent with the rest of the store and gives the
     admin a toast if the privileged-write is rejected). Revert-on-error is
     optional for v1 since the Stores tab re-fetches, but a revert is the
     cleaner pattern if the developer wants parity with other slices.

2. **No global `stores` cache change.** Do NOT route
   `fetchStoresIncludingInactive` through the slice that writes `s.stores` — that
   cache must stay active-only because current-store resolution
   ([useStore.ts:572](../src/store/useStore.ts)) and the store picker depend on
   it. The include-inactive list lives in `StoresTab` component-local state
   (the tab fetches on mount/focus). This is the lowest-blast-radius decision
   from Q5.

### Frontend UI (for the frontend-developer)

- `StoresTab` in [BrandsSection.tsx](../src/screens/cmd/sections/BrandsSection.tsx):
  on mount/focus call `db.fetchStoresIncludingInactive()` into local state and
  render rows from THAT, not from `useStore((s) => s.stores)` (which is why the
  INACTIVE `StatusPill` branch at lines 1123-1126 is currently dead code).
- Add an inline per-row toggle. On deactivate, gate behind `confirmAction`
  ([src/utils/confirmAction.ts](../src/utils/confirmAction.ts)); re-activate may
  skip confirm. On confirm, call `useStore.getState().updateStore(id, { status })`
  then optimistically update the tab-local list (or re-fetch).
- Reuse the existing ACTIVE/INACTIVE `StatusPill`.

### Tests

- **jest:** (1) `useStore.updateStore` now maps `status` into `dbUpdates` and
  delegates to `db.updateStore`; (2) `fetchStoresIncludingInactive` issues a
  SELECT with NO status filter and maps snake→camel; (3) the StoresTab toggle
  fires `confirmAction` on deactivate and calls `updateStore` with the new
  status. Mock `supabase`/`db` as the existing db.ts jest tests do.
- **pgTAP:** OPTIONAL but recommended as a regression pin even though no policy
  changes — assert that `privileged_update_stores` admits a status flip for an
  `admin`/`master`/`super_admin` of the store's brand and that a non-privileged
  (or cross-brand) caller's UPDATE affects 0 rows. This protects the gate the
  whole feature leans on. Since no migration lands, this is a standalone test
  file, not a migration-paired one.
- **shell smoke:** OPTIONAL — confirm `eod-reminder-cron` skips an inactive
  store (the spec's "confirm don't change" criterion). Low priority; the gate is
  a one-line `.eq` and the jest/pgTAP layer covers the write path.

### Risks and tradeoffs

- **0-row-on-RLS-denial is silent (not a 4xx).** A PostgREST UPDATE filtered by
  RLS returns 2xx with 0 rows, so a non-privileged caller who somehow reaches
  the write gets no error. Mitigation: the Stores tab is only reachable by admins
  in the Cmd UI, and the tab re-fetches, so a denied write self-corrects
  visually. Acceptable for v1; documented so a reviewer doesn't read it as a bug.
- **Stale include-inactive list across clients** (realtime caveat above) —
  accepted for v1.
- **Global-cache leakage risk.** The single biggest implementation footgun is
  accidentally writing `fetchStoresIncludingInactive`'s result into the global
  `stores` cache (or relaxing `fetchStores`). Either would surface inactive
  stores in current-store resolution and the staff picker — exactly the
  high-blast-radius outcome Q5 forbids. Called out as the primary review focus.
- **Performance:** trivial. `stores` is a tiny table; the seed has a handful of
  rows. Removing one `.eq` filter on a small, brand-scoped, RLS-filtered SELECT
  is a non-issue on the 286 KB seed dataset.
- **No edge-function cold-start impact** — no edge function touched.
- **Migration ordering:** N/A — no migration.

### Open questions / surfaces for PM

- None blocking. The `app.json` slug is untouched and out of scope (spec already
  excludes it). The `brandId`-not-writable decision in `updateStore` is an
  architect call to avoid tripping `auth_can_see_brand` WITH CHECK on a brand
  transfer; flag if a future spec needs store→brand reassignment (that would be
  its own privileged path with a self-/transfer-guard).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the Backend design in this spec. Backend-developer:
  add `db.ts` `updateStore` and `fetchStoresIncludingInactive` (no migration —
  the `privileged_update_stores` RLS policy already enforces the role gate;
  do NOT author a new policy/RPC), extend `useStore.updateStore` to map `status`
  and delegate to `db.updateStore`, and add the jest (+ optional pgTAP pin) for
  the write/read paths and the existing cron gate. Frontend-developer: wire the
  inline per-row toggle in `StoresTab` (confirm-on-deactivate via `confirmAction`,
  reuse the ACTIVE/INACTIVE `StatusPill`) reading from
  `fetchStoresIncludingInactive()` into tab-local state — do NOT write the global
  `stores` cache or relax `fetchStores`. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/083-store-deactivation-toggle.md

---

## Files changed (backend — backend-developer)

### src/lib/db.ts
- Added `fetchStoresIncludingInactive()` in the `// ─── STORES ───` block — a
  SELECT with NO `.eq('status','active')` filter, same projection/mapping as
  `fetchStores`, for the admin Stores tab only. Does NOT write the global
  `stores` cache. The existing `fetchStores` active-only filter is UNCHANGED.
- Added `updateStore(id, updates)` — a partial PostgREST UPDATE that maps only
  the keys present on `updates` (`name`/`address`/`eodDeadlineTime`/`status`).
  `brandId` is intentionally not writable. No migration / RPC / RLS policy —
  the existing `privileged_update_stores` policy enforces the
  admin/master/super_admin gate server-side.

### src/store/useStore.ts
- `updateStore` (Stores slice, ~line 1954): mapped `status` into the partial
  update (closing the documented persistence gap), replaced the inline
  `supabase.from('stores').update(...)` carve-out with a call to the new
  `db.updateStore`, and upgraded the error path to optimistic-then-revert via
  `notifyBackendError('Update store', e)` (snapshots `stores`/`currentStore`
  and reverts both on failure).

### Tests (jest — Track 1)
- src/lib/db.updateStore.test.ts — new. Covers `fetchStoresIncludingInactive`
  (no status filter, snake→camel mapping, error path) and `updateStore`
  (status mapping, snake_case column mapping, no-undefined-clobber, brandId not
  written, error path).
- src/store/useStore.updateStore.test.ts — new. Covers the `status` mapping +
  delegation to `db.updateStore`, pass-through of name/address/eodDeadlineTime,
  and optimistic-then-revert + `notifyBackendError` toast on db error.

### Tests (pgTAP — Track 2)
- supabase/tests/stores_privileged_update_status.test.sql — new. Standalone
  regression pin (no migration) for `privileged_update_stores`: admin/master of
  the brand can flip status (and reverse it), super_admin can flip cross-brand,
  while a non-privileged caller's and a cross-brand admin's UPDATE affect 0 rows.

---

## Files changed (FIXES_NEEDED round — backend-developer)

Addresses the backend/test items in
`specs/094-store-deactivation-toggle/reviews/release-proposal.md`. (The StoresTab
toggle jest test — proposal item 1 — is handled by the parallel
frontend-developer and is NOT in this list.)

### Tests (pgTAP — Track 2)
- supabase/tests/stores_privileged_update_status.test.sql
  - **CRITICAL 2 / AC5 cron-gate pin** (proposal item 2): added arms (7) and (8)
    (`plan(6)`→`plan(8)`) that reproduce eod-reminder-cron's exact active-store
    filter (`status = 'active'`, the gate at
    supabase/functions/eod-reminder-cron/index.ts:188) under the RLS-bypassing
    postgres role (the cron runs as the service role). Arm (7) asserts an
    inactive store is EXCLUDED (suppression); arm (8) asserts an active store is
    INCLUDED (so a filter removal can't pass by emptying the set). Reuses the
    end-of-txn state (foreign store inactive, Towson active) left by arm (6).
  - **Should-fix** (proposal item 4): arm (3) `sub` changed from
    `test.admin_id` to `test.master_id` so it impersonates the seed master user
    itself — exercising the master-profile `auth_can_see_brand` path end-to-end
    via the master's own brand_a `user_stores` grant (seed.sql:190-196) — rather
    than re-using the admin user with a master JWT claim.

### src/lib/db.ts
- **Should-fix** (proposal item 3): `updateStore` now returns early when
  `dbUpdates` has no mappable keys (`if (Object.keys(dbUpdates).length === 0)
  return;`), avoiding an empty-body no-op PATCH and matching the
  `updateRecipe`/`updatePrepRecipe` convention.

### src/store/useStore.ts
- **Should-fix** (proposal item 5): added a why-comment on `updateStore`'s
  explicit 4-field object passed to `db.updateStore`, documenting that the
  literal is required because `updates: Partial<Store>` is wider than
  `db.updateStore`'s `Partial<Pick<...>>` signature and that it intentionally
  drops `brandId` (avoids the brand-transfer `auth_can_see_brand` WITH CHECK
  footgun). No behavior change.

### Confirmed unchanged (acceptance criterion, no edit)
- supabase/functions/eod-reminder-cron/index.ts:188 — the
  `.eq('status','active')` gate is in place; both Track 1 (EOD) and Track 2
  (vendor) resolve their target store from that active-only array, so inactive
  stores are suppressed from both push and email-fallback streams. No change.

### Out of scope (touched by frontend-developer in parallel, NOT by me)
- src/screens/cmd/sections/BrandsSection.tsx — the inline per-row toggle wiring.
  This file was already modified in the working tree by the parallel
  frontend-developer; I did not edit it. NOTE: a typecheck error currently
  exists in that in-progress file (`Property 'stores' is missing` at line 658) —
  flagged here for the reviewers as frontend-in-progress, not a backend defect.

---

## Files changed (frontend — frontend-developer)

### src/screens/cmd/sections/BrandsSection.tsx
- `StoresTab` rewritten to read BOTH active and inactive stores via the new
  `db.fetchStoresIncludingInactive()` into **tab-local** state (filtered to the
  selected brand), instead of the active-only global `stores` cache. This makes
  the previously-dead INACTIVE `StatusPill` branch live. The global `stores`
  cache and `fetchStores` are NOT touched (verified: the active-only read still
  drops a deactivated store; the tab-local include-inactive read still surfaces
  it for re-activation).
- Added an inline per-row `ACTIVATE` / `DEACTIVATE` toggle. Deactivate routes
  through `confirmAction` (cross-platform) with copy explaining the store will
  stop receiving reminder notifications and that no data is deleted; re-activate
  applies immediately (non-destructive). Both call
  `useStore.getState().updateStore(id, { status })` (via the bound selector) and
  optimistically flip the tab-local row. Reconciliation happens on the
  mount / brand-change / create-drawer-close re-fetch effect; an immediate
  read-after-write re-fetch was intentionally avoided to prevent a
  PostgREST read-after-write flicker. Persistence/revert/toast on error is
  handled by `useStore.updateStore` (optimistic-then-revert +
  `notifyBackendError`).
- Tab-local fetch errors surface via `Toast.show` (the screen-level pattern;
  `notifyBackendError` is a private store helper not exported to screens).
- Added imports: `import * as db from '../../../lib/db'` and `Store` from
  `../../../types`.
- Removed the now-dead `selStores`/`allStores` plumbing: `StoresTab` no longer
  takes a `stores` prop (it self-fetches), so the `selStores` prop was dropped
  from `DetailPane` (signature, type, and both call sites) and the unused
  `allStores = useStore((s) => s.stores)` selector + `selStores` local were
  removed from `BrandsSection`.

### Verification
- `npx tsc --noEmit` clean (the prior frontend-in-progress error at line 658 is
  resolved — `StoresTab` no longer requires a `stores` prop).
- Full web app bundle (`expo/AppEntry.bundle`, platform=web) builds 200 / ~12 MB
  with no compile errors and contains the new code.
- Golden path exercised against the live local Supabase stack (admin@local.test)
  via the exact REST requests the UI issues: PATCH `{status:'inactive'}` returns
  1 row; active-only read drops the store; include-inactive read shows it as
  inactive; PATCH `{status:'active'}` re-activates (reversible). Confirms the
  global-cache-leakage guard and reversibility.
- Browser-driven UI verification (`preview_*` / chrome MCP) was NOT possible in
  this environment — those tools were not available in the agent toolset. The
  bundle-compile + live-REST golden-path checks above stand in for it; a
  reviewer with browser tooling should still click through the rendered toggle.

---

## Files changed (FIXES — frontend-developer, CRITICAL 1 of FIXES_NEEDED)

Addresses release-proposal item 1 (Critical): the missing jest test for the
StoresTab inline status toggle (closes AC1's "reflected on the row" clause and
all of AC2). CRITICAL 2 (eod-reminder-cron gate pin) was routed to the parallel
backend-developer and is NOT in this change set.

### src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx — new
- jest + `@testing-library/react-native` (already a devDependency `^13.0.0` —
  no new dependency added). 4 tests, all green:
  - loads the include-inactive list and renders the ACTIVE pill for an active
    store (AC1 render + the `db.fetchStoresIncludingInactive` mount fetch).
  - DEACTIVATE: invokes `confirmAction` (asserts the `'Deactivate store?'`
    title, the store name in the body, and the `'Deactivate'` confirm label),
    then on confirm calls `updateStore(id, { status: 'inactive' })` and the
    row's StatusPill optimistically flips ACTIVE → INACTIVE (AC2 + AC1 "row").
  - DEACTIVATE cancelled: when the user dismisses the confirm, `updateStore` is
    NOT called and the pill stays ACTIVE (edge case for AC2).
  - ACTIVATE: does NOT call `confirmAction` (non-destructive) and calls
    `updateStore(id, { status: 'active' })`, optimistically flipping the pill
    INACTIVE → ACTIVE (AC2 re-activation skips confirm).
- Mocks `confirmAction`, `db.fetchStoresIncludingInactive`, and
  `useStore.updateStore` (selector-aware) per the existing component-test
  pattern (VendorsSection.test.tsx). `StatusPill` is left REAL so the
  ACTIVE/INACTIVE label assertions read the actual rendered pill. `lib/supabase`
  is stubbed at the boundary because `BrandsSection` transitively imports the
  auth/supabase chain at module load (the same seam db.ts component tests use).

### src/screens/cmd/sections/BrandsSection.tsx
- Added a named `export` to the existing `StoresTab` sub-component (no behavior
  change) so the toggle wiring can be unit-tested in isolation without driving
  the full BrandsSection brand-select → tab-switch navigation. Mirrors the
  existing precedent of `POsSection` exporting `POHistoryTab`. No other change
  to this file in this FIXES pass.

### Verification
- `npm test` (full suite): 60 suites / 598 tests pass (was 594; +4 new).
- `npx tsc --noEmit` clean; `npx tsc -p tsconfig.test.json --noEmit` clean.
- Browser preview verification was not exercised in this pass — the change is a
  test-only addition plus a non-behavioral named export; the toggle behavior is
  now pinned by automated assertions.
