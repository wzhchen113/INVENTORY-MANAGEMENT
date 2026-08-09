# Security audit for spec 156 — Record quick-order / CSV / PDF exports as draft orders

Scope audited: the spec-156 surface only. Co-staged spec-155 files
(`src/lib/db.ts`, `src/i18n/*.json`, `supabase/functions/instacart-cart-link/index.ts`,
`scripts/smoke-instacart-cart-link.sh`, `StoreFormDrawer.*`, `BrandsSection.tsx`,
`PhoneApproveOrder.*`, `postalCode.*`, `useStore.updateStore.test.ts`,
`useStore.approveOrder.spec149.test.ts`, `db.mintInstacartCartLink.spec149.test.ts`,
`StoresTab.edit.test.tsx`, and the spec-155 hunks inside `src/store/useStore.ts`)
were **excluded** — audited separately.

Files read for this audit:
`src/store/useStore.ts` (spec-156 hunks: 136-207, 762-787, 3518-3636),
`src/screens/cmd/sections/ReorderSection.tsx`,
`src/screens/cmd/sections/phone/PhoneOrdering.tsx`,
the three new `*.spec156.test.*` files,
`src/lib/db.ts:1640-1795` (`upsertVendorDraftOrder`, read-only),
`supabase/migrations/20260504173035_per_store_rls_hardening.sql:183-251`,
`supabase/migrations/20260405000759_init_schema.sql:52-68,166-173`.

**Verdict: no Critical. Nothing here BLOCKS merge on security grounds.** Two
Medium findings, both the same root cause (a write key derived from *live* global
state read after an async gap the export introduced), plus two Lows.

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

- `src/store/useStore.ts:3581` + `:3591` (read after the call sites' export
  `await`s at `ReorderSection.tsx:409,494,503` / `PhoneOrdering.tsx:607,633,647`)
  — **the "synchronous snapshot" discipline (design D-2 property 1) protects
  against a store switch AFTER `recordExportedOrder` is invoked, but not against
  one that happens DURING the export it is recording.** The call sites are
  `async` closures: `await sharePurchaseOrder(...)` (native/mobile-web share
  sheet — user-paced), `await handlePdfExport(...)` (which does
  `await import('jspdf')` + `await import('jspdf-autotable')`,
  `ReorderSection.tsx:1164-1165` — a real chunk fetch with an idle main thread),
  and `await handleCsvExport(...)`. During any of those windows the desktop
  TitleBar store switcher is live. On resolution the closure still holds store
  A's `vendor` object, but `recordExportedOrder` reads
  `get().currentStore?.id` — now store **B** — and writes store A's lines under
  `store_id = B`.

  Impact: a `purchase_orders` row for store B whose `po_items.item_id` values are
  store A's `inventory_items` (items are store-scoped —
  `init_schema.sql:54`), carrying store A's quantities and per-unit costs and a
  store A `total_cost`. RLS admits the write (the operator can see both stores,
  so `auth_can_see_store()` passes for either), and afterwards **store-B-only
  members can read those quantities and costs** even though they cannot see
  store A — the item *names* won't resolve (the `inventory_items` join is still
  RLS-clipped), so the disclosure is unnamed item UUIDs + qty + cost, not a full
  catalog leak. For an `extension_ordering` vendor it also injects a phantom row
  into store B's `get_pending_extension_orders` queue (the §2 R-4 residual, now
  in the wrong store).

  Not rated High because there is no attacker-controlled path (it requires the
  authorized operator to switch stores inside a sub-second-to-few-second window),
  no privilege boundary is crossed by the *writer*, and the bad row is deletable
  from `POsSection` — no psql-only recovery. But this is precisely the property
  the spec claimed to have, so it should not ship silently.

  Fix (cheap, no `db.ts` or backend change): snapshot the store at export time
  and refuse on mismatch rather than record into the wrong store. Either pass it
  — `recordExportedOrder(vendor, { storeId, referenceDate })` — or, keeping the
  AC-3 one-arg shape, gate at each call site on the value already in the
  component closure:
  `if (currentStore?.id === useStore.getState().currentStore?.id) void recordExportedOrder?.(vendor)...`
  (`ReorderQuickOrderButton` would need a `currentStore` selector added at
  `ReorderSection.tsx:363`, beside the one it already adds). Dropping a record in
  a rare race is strictly better than filing it against the wrong tenant.

- `src/store/useStore.ts:3591` and `:3604` — **`referenceDate` is read from
  `reorderPayload` AFTER the export await, and `loadFromSupabase` sets
  `reorderPayload: null` on EVERY realtime reload** (`useStore.ts:1943`; the
  design states this itself at F-2). Concrete reachable chain, no store switch
  required: export #1 records → the draft INSERT echoes back on `store-{id}` →
  the 400 ms debounce fires `loadFromSupabase` → `reorderPayload = null`; export
  #2 (a PDF, pressed before the echo, still inside `await import('jspdf')`)
  resolves and records with `referenceDate = undefined`.

  `upsertVendorDraftOrder` then matches on `reference_date IS NULL`
  (`db.ts:1683-1696`) instead of the dated key, so it **inserts a second draft
  header** for the same `(store, vendor, day)`. The D-4 in-flight guard cannot
  collapse it either — the key string at `useStore.ts:3604` includes
  `referenceDate ?? ''`, so the undated call is a different key. Result: two
  `draft` POs for one export day, i.e. the AC-12 property fails on a path D-4
  does not cover, and for an `extension_ordering` vendor **two** entries in the
  pending list — doubling the "human fills it and orders twice" residual the
  design names in §2 as the accepted risk. (`has_po` in `report_reorder_list`
  matches on `reference_date`, so the undated twin is also invisible there.)

  Fix: same snapshot as above — capture `reorderPayload?.asOfDate` at export
  start and pass it, or refuse to record when `get().reorderPayload` is null at
  record time (an undated draft is worse than no draft, given the extension
  queue reads it).

---

### Low

- `src/screens/cmd/sections/ReorderSection.tsx:409,494,503`,
  `src/screens/cmd/sections/phone/PhoneOrdering.tsx:607,633,647` — the
  `.catch(() => {})` safety net swallows a rejection with **zero** signal (no
  `console.warn`, no toast). `recordExportedOrder` never rejects *after* its
  `try` opens, but the pre-`try` region (`useStore.ts:3581-3598`: the `get()`
  reads and `buildDraftOrderLines`, which dereferences `vendor.items`) is
  outside it, so a malformed `vendor` produces a silently-lost order record —
  the spec-031/032 silent-failure class. Recommend
  `.catch((e) => console.warn('[imr] record exported order:', e?.message || e))`.
  Same shape the code-reviewer flags for style reasons; the security angle is the
  missing signal, not the ergonomics. (The optional call
  `recordExportedOrder?.(...)` is safe — optional chaining short-circuits the
  whole chain, so the `.catch` is not invoked on `undefined`.)

- `src/store/useStore.ts:3630` → `notifyBackendError` (`useStore.ts:52-61`)
  renders `e.message` into a user-visible toast. On this path the realistic
  messages are `'Draft not recorded'` and the 30 s `InflightTimeoutError`, since
  `upsertVendorDraftOrder` swallows every PostgREST error internally
  (`db.ts:1698,1730,1737,1745,1751,1766,1778` — `console.warn(err.message)`,
  returns `null`). Inherited house convention, no change requested; recorded only
  so a future error-shape change on this path gets a second look. **No store,
  vendor, user id, item id, quantity, or cost reaches either the toast or the
  console from spec-156 code** — see the clean checks below.

---

### Clean — verified, not assumed

- **AC-1 / carve-out list not extended.** `grep -rn "supabase\.(from|rpc)"` over
  `ReorderSection.tsx`, `PhoneOrdering.tsx` and the three new test files: **zero
  matches**. The only write is `db.upsertVendorDraftOrder` at
  `useStore.ts:3608`, unchanged and called with the same param set
  `fillCartForVendor` uses (`useStore.ts:3548`). No forked draft-PO writer, no
  new `db.ts` export, no new direct-Supabase call site. `src/lib/db.ts`'s
  spec-156-relevant surface is untouched (its staged diff is spec 155's
  `InstacartAdvisory`).
- **Frontend-only claim re-verified independently of the architect.** The six
  statements `upsertVendorDraftOrder` issues are each admitted by an existing
  store-scoped policy — `store_member_{read,insert,update,delete}_purchase_orders`
  (`20260504173035_per_store_rls_hardening.sql:186-201`, all
  `auth_can_see_store(store_id)`) and `store_member_*_po_items`
  (`:206-251`, FK-scoped `exists (… auth_can_see_store(po.store_id))`). **No new
  table, no new policy, no `USING (true)`, no allowlist row for the spec-053
  permissive-policy lint.** Nothing under `supabase/**` is staged for spec 156.
- **No role-gate regression.** Spec 156 adds no `ADMIN_ROLES` set, no edge
  function, no SECURITY DEFINER RPC, no destructive/role-change path — the
  `super_admin` parity, last-of-role, self-guard and `escapeHtml` checks are all
  N/A here. Recorded inherited posture (**not** a spec-156 finding): the
  `purchase_orders` / `po_items` policies gate on *store membership*, not
  `auth_is_admin()` / `auth_is_privileged()`, so a non-privileged store member
  could already write a draft PO via PostgREST before this spec. Spec 156 adds no
  new caller class — the six sites are inside `src/screens/cmd/`, which
  `RoleRouter` mounts for admin roles only. No client-side `useRole()` value is
  used as a boundary anywhere in the diff.
- **No secrets, no env surface.** No `Deno.env`, no `process.env`, no
  `EXPO_PUBLIC_*`, no third-party key, no upstream fetch, no HTML rendering, no
  redirect, no file/URL input. Secret-pattern scan over the three new test files:
  clean.
- **No order contents logged.** `recordExportedOrder` emits no `console.*` of its
  own; the only reporter is
  `notifyBackendError('Record exported order', …)` — a static label with no
  store, vendor, user, item, quantity or cost interpolated. `buildDraftOrderLines`
  (`useStore.ts:169-187`) is pure and logs nothing. `upsertVendorDraftOrder` logs
  only `err.message`, unchanged.
- **Realtime.** No `supabase_realtime` publication change; the draft rides the
  existing `store-{id}` channel with its `store_id=eq.<id>` filter
  (`useRealtimeSync.ts:54`), so a client that cannot `auth_can_see_store()` the
  store receives nothing new. `po_items` remains unpublished.
- **Input validation / injection.** All values are server-sourced payload fields
  passed as bound PostgREST parameters; no dynamic SQL, no `EXECUTE`, no string
  interpolation into a query. `buildDraftOrderLines` drops id-less and
  non-positive lines (`useStore.ts:186`), and the `'__all__'` / empty-lines
  guards (`useStore.ts:3587`, `:3598`) prevent a header with no scope or no
  lines. The `recordingKeys` Set (`useStore.ts:207`) is released in a `finally`
  (`:3634`), so a throw or a 30 s inflight timeout cannot wedge a key.
- **No PII.** Nothing in the diff reads, writes, or logs a profile, email, name,
  phone number, or address; `created_by` is the caller's own id, as
  `fillCartForVendor` already writes.

---

### Dependencies

No `package.json` / `package-lock.json` change in the staged set — `npm audit`
skipped per process. No new import of any third-party module in the spec-156
diff (`jspdf` / `jspdf-autotable` are pre-existing dynamic imports in the
untouched export path).
