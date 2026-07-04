## Code review for spec 108

Scope: `src/utils/poShareText.ts` + `.test.ts`, `src/screens/cmd/lib/sharePo.ts` +
`.test.ts`, `src/screens/cmd/sections/POsSection.tsx` + its test, i18n ×3,
`jest.config.js`.

Overall: the pure/impure split is clean and matches the `reorderExport.ts` /
`shareReorder.ts` precedent closely — `poShareText.ts` imports exactly one
cross-module symbol (`formatQty`), takes no React/theme/store/i18n import, and
the labels-bundle extension (main-Claude's ruling on the design's flagged OQ)
is implemented exactly as described in the spec's "Implementation notes"
section and documented in-file. `sharePo.ts` mirrors `shareReorder.ts`'s
try/catch + never-throw + failureToast posture, the AbortError swallow is
correct and tested, and the native-primitive decision (RN `Share`, not
`expo-sharing`) is pinned in both a module comment and a test. i18n is
byte-parallel across en/es/zh-CN with natural (not machine-literal) zh-CN
wording, and the interrogative "Did you send it?" wording is preserved in all
three locales. `jest.config.js`'s testMatch addition is a single, narrowly
scoped glob mirroring the pre-existing staff/lib carve-out. One real
convention violation and one duplication should land before merge.

### Critical
(none)

### Should-fix
- `src/screens/cmd/sections/POsSection.tsx:380` — the new Share button's label
  uses a hardcoded `color: '#000'` instead of the `C.accentFg` token. Every
  other accent-styled button in the Cmd surface (`InventoryDesktopLayout.tsx:506`,
  `BrandsSection.tsx:433/864/937/1134`, `VendorsSection.tsx:163`,
  `UsersSection.tsx:147/330`, `ReportsSection.tsx:272`, `EODCountSection.tsx:1158`,
  `InviteUserDrawer.tsx:247`, etc.) uses `C.accentFg`, which flips between
  `#FFFFFF` and `#0E1014` depending on palette (`src/theme/colors.ts:192,222`).
  This is not a style nit — hardcoding `'#000'` will render the wrong-contrast
  (potentially illegible) label in whichever palette expects `#FFFFFF` for
  text-on-accent. The demoted email button right next to it correctly uses a
  token (`color: C.fg2`, line 391), confirming this is new code introduced by
  spec 108, not inherited styling. Fix: `color: C.accentFg`.
- `src/screens/cmd/sections/POsSection.tsx:150-156` and `:234-240` — the
  `.then(...).finally(...)` mark-as-sent block (setBusy(true) →
  `markPurchaseOrderSentManually` → success toast → setBusy(false)) is
  duplicated verbatim between `onMarkSent` and the auto-prompt inside `onShare`.
  The spec's own implementation notes acknowledge this ("the existing
  `onMarkSent` handler, whose `.then/.finally/toast` block is reused verbatim")
  but verbatim duplication of six lines of async-flow logic is exactly the
  kind of thing that drifts silently on the next edit (e.g. someone adds an
  error-path toast to one call site and forgets the other). Extract a small
  shared `runMarkAsSent(poId: string)` helper (or have `onShare`'s prompt
  literally call `onMarkSent`'s confirmed-callback body) so there's one place
  that owns "confirm → mark sent → toast → unbusy."

### Nits
- `src/utils/poShareText.ts:12-14,35-36,73-76` — the module-level doc comments
  describe the fallback as "per-item English fallback where the current locale
  has no translation for that item," which reads as if the injected resolver
  itself handles the no-translation case. In the actual call site
  (`POsSection.tsx:204-207`), the no-translation fallback is handled entirely
  *inside* `getLocalizedName` (silent English fallback) — the resolver's
  `fallbackName` parameter is only ever reached when no matching `inventory`
  row exists at all. `POsSection.tsx`'s own inline comment (lines 200-203) gets
  this exactly right ("itemName is the last-resort fallback when no inventory
  row is found"); the `poShareText.ts` docstring could be tightened to match.
  Not a functional issue — the AC itself uses the same combined phrasing.
- `src/screens/cmd/sections/POsSection.tsx:199` — `onShare` re-derives
  `poLines` from `poLinesById[sel.id] || []` rather than reusing the
  already-computed `lines` const from the outer render scope (line 112). Same
  array, harmless, but two names for one value inside the same component.
- `src/i18n/{en,es,zh-CN}.json:644` — the old `noEmailHint` key is now
  unreferenced from any component (repointed to `noEmailShareHint` at
  `POsSection.tsx:447`) but left in all three catalogs, exactly as the spec's
  D-5(c) flagged as an acceptable "leave it to avoid churn" choice. Fine per
  spec; flagging only so a future catalog-cleanup pass knows it's dead weight.
- `src/screens/cmd/lib/sharePo.ts:17-18` — the comment notes gating RN's
  `Share.share` availability via `expo-sharing`'s `Sharing.isAvailableAsync()`
  is a slightly odd cross-subsystem check (two different native share
  primitives). This is the spec's own explicitly-flagged, explicitly-accepted
  risk (D-2 "Risks and tradeoffs"), not something invented silently here —
  noting only because it's the kind of thing that could get "fixed" out from
  under the pinned decision in a later spec without re-reading the rationale.
  (out-of-scope — architect's post-impl review territory, not re-litigating
  here.)

---

## Resolution (applied by main Claude post-review)

- **Should-fix 1 — `color: '#000'` on the accent Share button — FIXED** → `C.accentFg`
  (the same Tier-1 contrast-bug class). The emphasis jest assertion updated to pin
  the TOKEN (mocked '#FFF'), not the old literal.
- **Should-fix 2 — duplicated confirm→mark-sent→toast→unbusy block — FIXED** →
  extracted `runMarkSent(poId)`, used by both `onMarkSent` and the did-you-send prompt.
- Nits left as noted (advisory).

Post-fix: jest 896/896, both typechecks exit 0.

## Browser verification (main Claude, preview tools)

Created a draft PO (BJs, 9 lines) → **SHARE PO renders as the primary action** →
clicked: desktop-web path fired, the **preview pane rendered** ("SHARED TEXT —
SELECT TO COPY": `I.M.R — Purchase order / Store: Charles / Date: 2026-07-04 /
72 × each Dr Pepper / …`) with **no `$` anywhere**; the honest **"Did you send
it?"** prompt fired and accepting flipped the PO draft → sent (chips updated).
**Re-share on the sent PO fired NO prompt** (suppression verified). The zh-CN
message rendering is pinned by the builder jest (full zh example); the in-browser
locale switch wasn't exercised (switcher not reachable in the harness). Test PO
cleaned up.
