# Security audit for spec 137

Scope: frontend-only Cmd-UI navigation unification — new `OrderingSection` tab
shell, `orderingHandoff` deep-link signal, sidebar/palette rewiring, saved-layout
id remap. The spec crosses no DB/RPC/edge/RLS boundary; no migration, no edge
function, no `verify_jwt` change. My audit focused on the four asks from the
dispatch: (1) no new `supabase.from/rpc` outside carve-outs, (2) the deep-link
`poId` is only equality-matched against already-authorized store-scoped PO lists
and never interpolated, (3) the sidebar-override remap can't be abused via
crafted localStorage, (4) no secrets / no data exposure.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
None.

---

### Detail / evidence

**1. No new Supabase call sites outside the `db.ts` carve-outs — confirmed.**
Grepped every changed file (`OrderingSection.tsx`, `orderingHandoff.ts`,
`sidebarLayout.ts`, `TabStrip.tsx`, `ResponsiveCmdShell.tsx`, `cmdSelectors.ts`,
`InventoryDesktopLayout.tsx`) for `supabase.from` / `supabase.rpc` /
`.functions.invoke` — zero matches. The deep-link is pure client Zustand state
(`src/lib/orderingHandoff.ts`); it reaches no network. Data still flows through
the pre-existing `createPoDraft` / `refreshPurchaseOrders` / `loadReorderSuggestions`
store actions, unchanged by this spec.

**2. Deep-link `poId` is a store-scoped equality match, no injection vector.**
The signal carries only a single `poId: string` (`orderingHandoff.ts:19`). Its
sole consumer is `POsSection.tsx:122-127`, which calls `setSelectedId(pendingPoId)`
then `consume()`. `selectedId` is resolved only via
`sel = filtered.find((o) => o.id === selectedId)` (`POsSection.tsx:129`), where
`filtered` derives from `orderSubmissions.filter((o) => o.storeId === currentStore.id)`
(`POsSection.tsx:95-106`). So a `poId` that is not already present in the caller's
own store-scoped, RLS-authorized PO list resolves to `sel === undefined` and
renders nothing — no cross-store leak, no crash. The subsequent DB fetch
`loadPurchaseOrderLines(sel.id)` (`POsSection.tsx:136`) uses `sel.id` from the
already-filtered authorized row, never the raw `pendingPoId`. The value is never
interpolated into a query, URL, or template — it is only compared with `===` and
passed to React `setState`. Even in the adversarial case (a sibling-app user
racing a forged id into the signal — not actually reachable, since the signal is
a same-process in-memory Zustand store with no external writer), RLS on
`purchase_orders` remains the real boundary and is untouched.

**3. Sidebar-override remap is a pure, read-only lookup — no localStorage abuse.**
`remapLegacySidebarOverrideIds` (`sidebarLayout.ts:82-97`) does a static
`Record` lookup `LEGACY_SIDEBAR_ID_ALIASES[entry.id] ?? entry.id` against a
two-key object literal, dedupes via a `Set`, and returns a shallow-copied array.
No `eval`, no `new Function`, no dynamic import, no dynamic property *write*
(only a read), so no prototype-pollution or code-exec path from a crafted
`profiles.sidebar_layout` blob. Inputs are already shape-guarded by
`isValidOverride` (`sidebarLayout.ts:46-60`, enforces `typeof e.id === 'string'`)
before reaching the store, so `entry.id` is always a string. A crafted/unknown id
that survives simply fails to match any `defaultGroups` id downstream and is
dropped by `applySidebarOverride` — the pre-existing stale-id behavior. Worst
case for a malicious local override is a cosmetic self-inflicted sidebar layout,
not a security boundary crossing. The client-side `useRole()` placeholder is not
used anywhere in these changes as an authorization gate.

**4. No secrets, no PII, no data exposure.**
Grepped the new/core changed files for `process.env` / `EXPO_PUBLIC` /
`Deno.env` / `service_role` / `apiKey` / `secret` / `token` — zero matches.
Nothing is logged; no error strings expose SQL, stack traces, or foreign-store
rows. The new `testID`s (`ordering-tab-reorder`, `ordering-tab-pos`,
`ordering-root`) are inert DOM markers. `TabStrip.tsx` change is an additive
optional `testID?: string` passthrough (`TabStrip.tsx:9-11,37`) — no
`dangerouslySetInnerHTML`, no HTML interpolation.

### Dependencies
No `package.json` changes in this spec — `npm audit` skipped.

---

Verdict: this is a clean frontend-only navigation/handoff change. No auth,
authz, secret, validation, or dependency findings at any severity. Nothing
blocks merge from a security standpoint.
