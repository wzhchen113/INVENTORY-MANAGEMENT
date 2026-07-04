# Security audit for spec 108 — "Share PO" (message / WeChat share)

Scope: LIGHT review. Frontend-only spec — no migration, no edge function, no
RPC, no `src/lib/db.ts` change, no RLS surface, no new realtime publication.
The one real security-relevant property is that the built share text **leaves
the app** into third-party channels (Messages / WeChat / clipboard), so the
audit centers on what that text can and cannot carry, and on whether the flow
can be driven against data the caller can't see.

Files reviewed:
- `src/utils/poShareText.ts` (new, pure builder)
- `src/screens/cmd/lib/sharePo.ts` (new, impure platform orchestrator)
- `src/screens/cmd/sections/POsSection.tsx` (wiring — `onShare`, preview pane)
- `src/i18n/{en,es,zh-CN}.json` (new `section.purchaseOrders.*` keys)
- `jest.config.js` (testMatch glob extension)
- Supporting: `src/lib/db.ts:1404` (`PoLine` shape), `src/utils/reorderExport.ts`
  (`formatQty` reuse), `src/i18n/localizedName.ts` (`getLocalizedName`),
  `src/screens/staff/lib/shareReorder.ts` (precedent)

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

None.

---

### Low / Nits (non-blocking — informational)

- `src/screens/cmd/lib/sharePo.ts:71` — the failure Toast's `text2` interpolates
  `message.slice(0, 120)` (the caught error's `.message`). This is the error
  string, **not** the PO body, so no vendor data or cost leaks into the toast —
  confirmed safe. Noted only because it surfaces raw exception text to the UI;
  identical posture to the audited `shareReorder.ts:75` precedent, so it is
  consistent and acceptable. No change required.

- `src/screens/cmd/lib/sharePo.ts:67` — `console.warn('[imr] share PO failed:',
  message)` logs the **error message only**, never the share `text`. Verified
  the full PO body is never passed to `console.*`. This matches the "no full
  share text logged" requirement in the brief. No change required.

---

### Verification notes (the load-bearing checks, all PASS)

**1. No `$` / cost basis / totals anywhere in the vendor-facing text — PASS.**
The builder's input type `PoShareLine` (`src/utils/poShareText.ts:38-43`) is
deliberately reduced to exactly `{ itemId, itemName, orderedQty, unit }`. The
full `PoLine` (`src/lib/db.ts:1404-1413`) carries `costPerUnit`, `receivedQty`,
and `subUnitSize`, but the caller `POsSection.onShare`
(`src/screens/cmd/sections/POsSection.tsx:212`) maps each line to **only** the
four non-cost fields:
`lines: poLines.map((l) => ({ itemId, itemName, orderedQty, unit }))`.
Cost can therefore not smuggle through the builder's input — the type would
have to change for money to enter. `buildPoShareText` never imports
`formatMoney` (it imports only `formatQty` from `./reorderExport`,
`poShareText.ts:29`) and the output template emits no currency glyph. The
builder's own jest suite asserts the output contains no `$` (per the module
docstring, `poShareText.ts:19`). Confirmed.

**2. No internal ids / no user PII in the shared text — PASS.**
The output template emits: `header` label, `storeLabel: storeName`,
`dateLabel: referenceDate`, one `{qty} × {unit} {name}` line per item, and an
`itemsCount` line (`poShareText.ts:100-126`). `itemId` is used only as the
resolver key and is **never emitted** (only the resolved display name is).
`storeName` and `referenceDate` are the only header dynamics — no PO uuid, no
`vendorId`, no manager name/email, no user id, no notes field enters the
builder or the output. The vendor's own name is not even in the text (it's a
message *to* the vendor). Confirmed against both the builder and the call site.

**3. Injection-irrelevant — plain text, never rendered as HTML — PASS.**
`buildPoShareText` returns a `\n`-joined plain string; no HTML, no template
that an escape helper would be needed for (unlike `reorderExport.ts`'s
`buildReorderPdfHtml`, which correctly escapes — not in scope here). The
desktop-web preview renders the string in a React Native `<Text selectable>`
node (`POsSection.tsx:459-461`), which is a text sink, **not** a web HTML sink.
Grep for `dangerouslySetInnerHTML` / `innerHTML` across `src/screens/cmd`,
`sharePo.ts`, and `poShareText.ts` returns nothing. The clipboard path writes
the raw string via `navigator.clipboard.writeText(text)`
(`sharePo.ts:88`) and `navigator.share({ text })` (`sharePo.ts:126`) — both
text APIs, no markup interpretation. No XSS surface.

**4. Clipboard path carries no sensitive data beyond the same text; no full-text
console logging — PASS.** `copyToClipboard` (`sharePo.ts:81-101`) writes exactly
the same `text` that every other branch shares. The only `console.*` call
(`sharePo.ts:67`) logs the caught error message, never the body. No token, key,
or PII is in scope here (the module makes zero Supabase / network calls).

**5. Share flow cannot fire on POs the caller can't see — PASS.**
Neither new file makes any data access — grep for `fetch(` / `supabase.` /
`.from(` / `.rpc(` in `poShareText.ts` and `sharePo.ts` returns nothing; the
orchestrator receives a pre-built `text: string` and the builder receives a
pre-mapped `PoShareInput`. All source data in `POsSection.onShare` comes from
already-loaded, RLS-scoped Zustand store slices — `poLinesById[sel.id]`,
`inventory`, `currentStore`, and `sel` (from `orderSubmissions`, filtered to
`currentStore.id` at `POsSection.tsx:86`). `POsSection.tsx` itself contains no
`fetch` / `supabase` / `.from` / `.rpc`. There is no path to read another
store's PO into the share text — the store slices are populated under
spec-107's per-store `auth_can_see_store(store_id)` policies, and this spec adds
no new read path. Confirmed no bypass.

**6. Status write reuses the RLS-scoped spec-107 path — PASS.**
The draft-only auto-prompt invokes the existing
`markPurchaseOrderSentManually(sel.id)` store action
(`POsSection.tsx:236`), which calls `db.markPurchaseOrderSent`
(`src/store/useStore.ts:2510-2512`) — the spec-107 confirm-gated, store-scoped
`purchase_orders` UPDATE under `auth_can_see_store`. No new store action, no new
write path, no new RLS surface. The prompt is correctly gated on
`shared && selStatus === 'draft'` (`POsSection.tsx:230`) and is suppressed on
sent/partial re-share and on the `AbortError` dismiss path
(`sharePo.ts:136-138` returns `shared: false`), so status never auto-flips.
(These are correctness properties; the security-relevant fact is only that the
write rides an already-hardened path — it does.)

**7. i18n strings introduce no injection / no PII — PASS.**
The new `section.purchaseOrders.*` keys in all three locales
(`en`/`es`/`zh-CN`) are static UI copy plus `{vendor}` / `{count}`
interpolations resolved through the existing `T()` machinery. The shared-body
keys (`shareBodyHeader`, `shareBodyStoreLabel`, `shareBodyDateLabel`,
`shareBodyItemsCount`, `shareBodyNoItems`) are fixed labels; the only dynamic in
the body is `{count}` (a number). No secret, id, or PII is embedded in any
locale string. The honest-prompt interrogative wording is preserved in all
three locales (`Did you send it?` / `¿La enviaste?` / `你发送了吗？`).

**8. No new dependencies — PASS.** `package.json` is not in the diff (design D-1
chose web-only `navigator.clipboard.writeText` behind a runtime guard over
adding `expo-clipboard`). `npm audit` was therefore not run — see Dependencies
below. The `jest.config.js` change is a testMatch glob extension only
(`src/screens/cmd/lib/**/*.test.ts`), the exact sibling of the existing
`src/screens/staff/lib/**` carve-out — no runtime surface, no dependency.

---

### Dependencies

No `package.json` changes — `npm audit` skipped (per process step 3, audit runs
only when `package.json` changed). The desktop-web copy path uses the
platform-native `navigator.clipboard` API behind a `typeof navigator` guard
(`sharePo.ts:82-86`); no `expo-clipboard` or other package was added.

---

### Verdict

No Critical, no High, no Medium. Two Low informational notes (both consistent
with the audited `shareReorder.ts` precedent, neither requires a change). The
one genuine security surface — a plain-text artifact leaving the app into
third-party channels — is clean: no cost basis, no ids, no PII in the body;
plain text with no HTML sink; RLS-scoped source data with no fetch bypass; and
the status write rides spec-107's already-hardened per-store path. Nothing here
blocks the spec from advancing on security grounds.
