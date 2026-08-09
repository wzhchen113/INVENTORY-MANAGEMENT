## Code review for spec 155

Scope reviewed: every file in spec 155's "Files changed" list (backend half + frontend
half), against the spec's design rulings (§0 ruling summary, §4-§8) and ACs. Files
belonging to the in-progress spec-156 parallel work were not reviewed and are out of
scope here.

### Critical

None found. The implementation tracks the spec closely across the edge function,
`db.ts`, `useStore.ts`, the drawer/tab surfaces, i18n, and tests. Specific checks
called out below:

- `db.updateStore` literal at `src/store/useStore.ts:3064-3070` is widened to the
  named five-field literal (`+ postalCode`), never a spread, with the `brandId`-drop
  comment extended as the spec required (§6.1). Both production call sites were
  verified: `StoresTab.setStatus` (`src/screens/cmd/sections/BrandsSection.tsx:1135`)
  stays fire-and-forget (`void updateStore(...)`), and `StoreFormDrawer.handleSave`
  (`src/components/cmd/StoreFormDrawer.tsx:104-117`) awaits the boolean, toasts only
  on success, and keeps the drawer open with input intact on `false` (AC-6). The
  `Promise<boolean>` JSDoc at `useStore.ts:574-579` correctly documents "never
  rejects."
- The onSaved-before-onClose sequencing (`StoreFormDrawer.tsx:109-117`,
  `BrandsSection.tsx:1146-1161`) is a deliberate, well-reasoned deviation from the
  PM's AC-5 parenthetical, and it is the right call: deferring the reconciling
  `refresh()` until *after* the write settles (rather than keying it off
  `[refresh, drawerOpen]`) avoids the exact spec-094 refetch-races-the-PATCH
  flicker documented at `BrandsSection.tsx:1094`. `StoresTab.edit.test.tsx` pins
  both the non-firing case (edit-close without save) and the RLS 0-row snap-back
  (AC-7), so this isn't just asserted in a comment — it's exercised.
- Edge function advisory arms (`supabase/functions/instacart-cart-link/index.ts:439-518`):
  the entire retailers probe (fetch, `.json()`, `availableKeys` construction) is
  wrapped in one `try/catch` so `UpstreamTimeout` cannot reach the outer 504 handler
  — confirmed by reading through to the outer `catch (e)` at line 606, which only
  handles the `products_link` mint's own `idpFetch`. The probe gets its own 3s
  budget (`RETAILERS_PROBE_TIMEOUT_MS`) via the added third `idpFetch` arg, and
  `products_link` still uses the 10s default. The unparseable-body judgment call
  (line 484-492, deliberately *not* `.catch(() => null)` on `.json()`) is correct
  reasoning: an unparseable body throws into the local catch and becomes
  `retailers_probe_failed`, keeping `retailers=0` meaning exactly "empty market"
  rather than conflating it with "probe broke."
- `disclosureKeyForChannel` was fully replaced by `disclosureKeysForChannel`
  (`PhoneApproveOrder.tsx:95-99`) with no sibling helper; grep confirms the old name
  survives only in comments. Order (fee line, then picker line) is enforced by both
  the function and the render (`PhoneApproveOrder.tsx:460-462`), and pinned in
  `PhoneApproveOrder.test.tsx:175-188` plus a render-order assertion at :253-255.
- i18n parity verified directly: `instacartPicker`, `advisoryNoPostalCode`,
  `advisoryRetailerNotInZip`, `advisoryProbeFailed`, and the revised
  `retailerUnavailable` / `instacartRetailerKeyHelp` copy are present with matching
  keys in `src/i18n/en.json`, `es.json`, `zh-CN.json` (all at line 1294-1300 /
  1045). `src/screens/staff/i18n/*` has no matches for any of the new keys —
  AC-REG-5 holds.
- AC-REG freezes: `src/utils/orderChannel.ts` has zero Instacart/disclosure-related
  changes; the `retailer_unavailable && allowFallback` branch and its two pinning
  tests in `useStore.approveOrder.spec149.test.ts:335-363` are byte-identical to
  the frozen spec-149 shape (only the AC-17 advisory-toast block was added
  *before* this branch, not inside it). No `supabase/migrations/*` file was added
  or touched.

### Should-fix

- **No live browser/preview pass was performed** (per the PR's own gates note:
  "Interactive browser verification was not possible in this run"). This leaves
  one piece of AC-12 formally unverified: "no horizontal scroll at 390px width"
  and the dark-theme render of the now-two-line Instacart disclosure block.
  RTL/jest render tests confirm the *text content and order* (`PhoneApproveOrder.test.tsx:242-256`)
  but do not perform real layout/wrap measurement, and the jest theme mocks
  (`StoreFormDrawer.test.tsx:20-29`, `StoresTab.edit.test.tsx:26-35`) only exercise
  a light-theme color set — dark mode is never rendered in any spec-155 test.
  This is genuinely new rendered surface (a second line inside
  `phone-approve-disclosure`, and a new EDIT drawer state on phone widths), so I'd
  treat the wrap/no-scroll and dark-mode claims in AC-12 as unverified rather than
  passed. Recommend the human pass the PR description already calls for
  ("a human pass through Brands → Stores → EDIT") be extended explicitly to also
  cover: (a) the Instacart disclosure block at 390px width in both themes, and
  (b) the EDIT drawer at phone width in both themes — before merge, not after.

### Nits

- `src/screens/cmd/sections/BrandsSection.tsx:173-175` — the drawer header's
  "● unsaved" badge is unconditional (renders regardless of dirty state) and is
  now shown against freshly-loaded, unmodified data the moment the EDIT drawer
  opens. This is a pre-existing quirk inherited from CREATE mode (where it was
  always accurate, since a new store starts blank) rather than something spec 155
  introduced — out-of-scope for this review, flagging only because EDIT mode is
  the first surface where the label reads as inaccurate on open.
- `src/components/cmd/StoreFormDrawer.tsx` — both `StoresTab`-owned instances
  (create + edit) independently call `useStore((s) => s.addStore)` /
  `useStore((s) => s.updateStore)`; harmless (Zustand selector, not a subscription
  cost of consequence) and consistent with the spec's deliberate "two separate
  pieces of state" design — not worth restructuring (out-of-scope).
