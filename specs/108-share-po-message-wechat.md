# Spec 108: "Share PO" — send a purchase order to vendors via text message / WeChat

Status: READY_FOR_REVIEW

## User story
As a store manager whose vendors do not use email (they text or use WeChat),
I want to share a purchase order as clean, message-friendly text from the PO
detail so that I can paste it into Messages/iMessage or WeChat and send it
myself from my own account, then have the app record the PO as sent — without
Twilio, an Official Account, or any per-message send API.

## Context (owner-decided direction — do not re-litigate)
- Spec 107 (live in prod) closed the PO loop with an **email** channel + a
  **manual "mark as sent"** fallback. For this owner, manual is currently the
  only real path because vendors are message/WeChat-only.
- Channel analysis, agreed with the owner: WeChat has no usable 1:1 send API
  that fits texting a vendor rep (OA / WeCom sends originate from the manager's
  own WeChat, not the app); Twilio-class SMS carries A2P 10DLC onboarding
  friction + per-message cost, and reps expect a text from the manager they
  know. **Decision: the share-sheet approach.** The app formats the PO as clean
  text; the manager sends it themselves from Messages/WeChat; the app then marks
  it sent. Frontend-only. No migration, no edge function.

## Acceptance criteria
- [ ] A "Share PO" action is available in the PO detail action row in
      `src/screens/cmd/sections/POsSection.tsx`, alongside the existing spec-107
      actions, with a stable `testID` (e.g. `po-action-share`).
- [ ] Pressing Share builds a plain-text representation of the selected PO from
      the already-loaded `poLinesById[sel.id]` lines (no new network fetch for
      the text body) containing, in order: a one-line **header** (store name +
      reference/order date), **one line per item** (quantity × unit × item
      name), and a trailing **line count** (e.g. "5 items"). **No dollar amounts
      appear anywhere** in the vendor-facing text — the cost basis stays private.
- [ ] Item names in the shared text resolve via `getLocalizedName(inventoryRow,
      locale)` in the **current app locale at share time**, re-resolved against
      the `inventory` row's `i18nNames` for each line (because `poLinesById`
      lines carry only an already-resolved plain **English** `itemName` string,
      NOT `i18n_names`). Per-item **English fallback** where the current locale
      has no translation for that item.
- [ ] The share text builder is a PURE, framework-free function (no React, no
      theme, no supabase) placed in a shared util under `src/utils/`, mirroring
      the `src/utils/reorderExport.ts` builder pattern, and is unit-testable with
      jest. Quantity/unit formatting reuses the existing `formatQty` helper. It
      does NOT format or receive money (no `formatMoney` in this builder — no $
      in the output).
- [ ] Delivery is platform-branched (mirrors `src/screens/staff/lib/shareReorder.ts`):
      - **native** (`Platform.OS !== 'web'`): open the OS share sheet via
        `expo-sharing` (`Sharing.shareAsync`) with the PO text; availability is
        checked via `Sharing.isAvailableAsync()` before any temp file is written.
      - **mobile web** (`navigator.share` present): call `navigator.share({ text })`.
      - **desktop web** (`navigator.share` absent): copy the text to the
        clipboard AND render a visible, selectable text preview of the exact
        shared string so the manager can copy manually if the clipboard write
        is blocked.
- [ ] On desktop web, the clipboard write path succeeds with a success toast on
      copy, and does not silently no-op when `navigator.clipboard` is
      unavailable — the visible preview is the always-present fallback.
- [ ] After a completed share/copy on a **draft** PO, the app **auto-prompts** an
      honestly-worded "Did you send it? → Mark as sent" confirm that invokes the
      existing `markPurchaseOrderSentManually(sel.id)` store action (the same
      confirm-gated PostgREST status update + audit row spec 107 already ships).
      The status **never auto-flips** without the prompt; **declining leaves the
      status unchanged (still draft)**. No new store action for status change.
- [ ] Share is exposed on **draft**, **sent**, and **partial** POs.
      `received` and `cancelled` show no Share button. On **sent/partial**, Share
      acts as a **reminder re-share with NO status change** and the mark-as-sent
      prompt is **suppressed** (the PO is already sent — prompting to mark it
      sent again would be nonsensical). The auto-prompt fires only from the
      **draft** path.
- [ ] Share is the **primary** action (accent styling) in the PO detail action
      row. When `vendors.email` is present, the existing spec-107 email send
      button remains as a **secondary** action; when `vendors.email` is empty,
      the existing `po-no-email-hint` warn text is **repointed to nudge toward
      Share** (Share, not email/manual, is the primary path for this owner's
      vendor list). Email send stays gated on `vendorEmail` as spec 107 shipped.
- [ ] All new user-facing strings (button label, share-sheet dialog title,
      toast text, the "Did you send it?" prompt, preview label, the repointed
      no-email hint) are added to the main i18n catalog in all three locales
      (en / es / zh-CN). No hardcoded copy in the component.
- [ ] Share/copy failures surface via the existing toast mechanism
      (`notifyBackendError` / `Toast.show`) and never throw to the caller — same
      posture as `shareReorder.ts`.

## In scope
- A "Share PO" affordance on the PO detail in `POsSection.tsx`, styled as the
  primary action; email demoted to secondary (when present).
- A pure share-text builder for a single PO (shared util under `src/utils/`;
  jest-covered): header + one line per item (qty × unit × name) + line count,
  **no dollar amounts**.
- Current-app-locale item-name resolution at share time via `getLocalizedName`
  against `inventory` `i18nNames`, with per-item English fallback.
- Cross-platform delivery: native share sheet (`expo-sharing`), mobile-web
  `navigator.share`, desktop-web clipboard + visible preview.
- Auto-prompt "Did you send it? Mark as sent" after share/copy on a **draft**
  PO, wired to the EXISTING `markPurchaseOrderSentManually` flow; prompt
  suppressed on sent/partial re-share.
- Repointing the `po-no-email-hint` at Share.
- i18n strings for the new affordance in en / es / zh-CN.
- Jest coverage of the pure text builder (and, if feasible, the platform-branch
  selection logic).

## Out of scope (explicitly)
- **Any WeChat / SMS send API, Twilio, A2P 10DLC, Official Account, or WeCom
  integration.** Owner-decided: the manager sends the message themselves. The
  app only formats + hands off text.
- **Dollar amounts / cost basis in the vendor-facing text.** OQ-1 resolved to
  quantities only; the manager's cost basis stays private (no per-line price, no
  total value).
- **New migrations, RPCs, or edge functions.** Frontend-only; the status change
  reuses spec 107's existing `markPurchaseOrderSentManually` path unchanged.
- **Changing the spec-107 email channel or its "mark as sent" behavior.** This
  spec ADDS a channel; it does not alter `sendPurchaseOrderEmail` or the
  lifecycle guards. Email demotes to a secondary button but its `vendorEmail`
  gate and send behavior are untouched.
- **Automatic detection of whether the manager actually sent the message.** Web
  share/copy cannot confirm a send; the mark-as-sent prompt is deliberately
  worded as a question ("Did you send it?"), not an assertion, and declining is
  a no-op.
- **A share affordance in the staff app.** This is the admin Cmd surface only.
- **Attaching a PDF/CSV to the share** (spec 089 already covers reorder-list
  file export; this spec is a text message, not a document). OQ-1 resolved to a
  text message, not a document.
- **PO create/edit changes.** Line editing, cancel, close-short, receiving all
  stay exactly as spec 107 shipped.
- **A share shortcut from the reorder card** after create-PO. OQ-5 resolved to
  **PO detail only** for v1; the reorder-card shortcut is future work.
- **A `sms:` / `mailto:`-style deep link.** WeChat has no prefill deep link and
  the share sheet covers both Messages and WeChat in one affordance; not in v1.
  (`vendors.phone` exists and is captured under Dependencies for a future spec.)

## Open questions resolved
- **Q (OQ-1): Text format + costs — full per-item lines vs compact summary, and
  include $ costs or quantities only?**
  → A: **Full lines, NO $ costs.** A one-line header (store name + reference
  date), one line per item (quantity × unit × item name), and a trailing line
  count. **No dollar amounts anywhere** in the vendor-facing text — the cost
  basis stays private. (Text message, not a document; PDF/CSV attach stays out.)
- **Q (OQ-2): Which item NAME goes in the shared text — current-locale, English,
  or always-Chinese-when-available?**
  → A: **Current app language.** Resolve item names via `getLocalizedName` in the
  CURRENT app locale at share time, **re-resolved against the `inventory` row's
  i18n_names** (because `poLinesById` lines carry only the plain English string —
  the caveat documented in the original OQ-2). **English fallback** per item
  where no translation exists in the current locale.
- **Q (OQ-3): After-share mark-as-sent — auto-prompt vs fully manual?**
  → A: **Auto-prompt after share/copy**, honestly worded ("Did you send it? →
  Mark as sent"). The app **never auto-flips** status without the prompt;
  **declining leaves status unchanged.**
- **Q (OQ-4): Which statuses can Share, and does re-share change status?**
  → A: **Share available on draft + sent + partial.** Draft-share triggers the
  mark-as-sent prompt. Sent/partial re-share is a **reminder with NO status
  change**, and the prompt is **suppressed** when the PO is already sent (cleanest
  wording — prompting to "mark as sent" a PO that is already sent is nonsensical).
  `received`/`cancelled` show no Share.
- **Q (OQ-5): Placement — PO detail only, or also a reorder-card shortcut?**
  → A: **PO detail only in v1.** The reorder-card shortcut is future work.
- **Q (OQ-6): Email button when `vendors.email` is empty — repoint the no-email
  hint at Share, and make Share visually primary?**
  → A: **Share becomes the PRIMARY action** (accent styling). Where the vendor
  has no email, the existing `po-no-email-hint` **repoints at Share**. Email
  remains a **secondary** button only when `vendors.email` is present, gated on
  `vendorEmail` as spec 107 shipped.

## Architect decisions (flagged — not decided by PM)
These are deliberately left for `backend-architect` to resolve in the design doc:
- **Desktop-web copy mechanism.** Add `expo-clipboard` (SDK-54-aligned, works on
  all platforms) vs. use web-only `navigator.clipboard.writeText` directly behind
  a `Platform.OS === 'web'` guard (no new dependency, web-only — acceptable since
  the copy fallback is a desktop-web-only concern). `expo-clipboard` is NOT
  currently in `package.json`.
- **Platform split shape.** native → `expo-sharing` (`Sharing.shareAsync`);
  mobile web → `navigator.share({ text })`; desktop web → clipboard + visible
  preview. Confirm the branch predicate order and the availability checks
  (`Sharing.isAvailableAsync()`, `navigator.share` presence,
  `navigator.clipboard` presence) mirror `shareReorder.ts`.
- **Home of the pure text formatter.** A `src/utils/` pure module per the
  `reorderExport.ts` precedent (jest-covered). Confirm the exact filename and
  the builder's input shape (PO header fields + the `poLinesById[sel.id]` lines +
  the resolver callback for locale names).

## Dependencies
- Spec 107 (live): `POsSection.tsx` lifecycle + status vocabulary
  (draft|sent|partial|received|cancelled), `markPurchaseOrderSentManually` store
  action (confirm-gated PostgREST status update + audit row),
  `loadPurchaseOrderLines` / `poLinesById` (lines with `itemName`, `orderedQty`,
  `unit`, `costPerUnit`, `receivedQty`), and the existing `vendorEmail` gate.
- `expo-sharing@~14.0.8` — ALREADY a dependency (used by the staff reorder
  share). Reused for the native share sheet.
- **Desktop-web clipboard dependency — architect decision (see above):**
  `expo-clipboard` (NOT currently in `package.json`) vs. web-only
  `navigator.clipboard.writeText` behind a `Platform.OS === 'web'` guard.
- Precedent to mirror: `src/utils/reorderExport.ts` (pure builder, one shared
  layout) and `src/screens/staff/lib/shareReorder.ts` (impure cross-platform I/O
  orchestrator branching on `Platform.OS`).
- `src/i18n/localizedName.ts` `getLocalizedName` + `inventory` rows carrying
  `i18nNames` — REQUIRED (OQ-2 resolved toward current-locale item names, which
  re-resolve each line against `inventory.i18nNames`).
- `vendors.phone` exists (types/index.ts line 436) — enables an OPTIONAL future
  `sms:` deep link; NOT in v1. Captured for a future spec.
- i18n main catalog: `src/i18n/{en,es,zh-CN}.json` — new strings in all three.

## Project-specific notes
- Cmd UI section / legacy: **Cmd UI** — `src/screens/cmd/sections/POsSection.tsx`.
  No legacy admin surface.
- Per-store or admin-global: **per-store** — POs are store-scoped; the detail
  already filters `orderSubmissions` by `currentStore.id`, and the status
  change rides spec 107's existing store-scoped path. No new RLS.
- Realtime channels touched: **none new.** The mark-as-sent status change already
  flows through spec 107's path; other clients already reload on the
  `store-{id}` channel. This spec adds no new realtime publication surface, so
  the realtime-publication gotcha does not apply.
- Migrations needed: **no.**
- Edge functions touched: **none.**
- Web/native scope: **web + native.** Native uses `expo-sharing`; mobile web uses
  `navigator.share`; desktop web uses clipboard + a visible text preview. The
  desktop-web copy fallback is the load-bearing case since the admin Cmd surface
  is web-primary/desktop.
- app.json slug: not touched. (No build-identifier / push-cert change; the
  `towson-inventory` slug is out of scope and stays as-is.)
- Tests: **jest track** (pure text builder; ideally the platform-branch
  selection). No pgTAP (no DB change) and no shell smoke (no edge function).

---

## Backend design

**This spec is FRONTEND-ONLY. There is no backend slice.** No migration, no
edge function, no RPC, no PostgREST contract change, no `src/lib/db.ts` surface,
no RLS impact, and no new realtime publication. The only DB write in the whole
flow is the existing spec-107 `markPurchaseOrderSentManually(sel.id)` store
action — reused verbatim, unchanged. The sections below that a normal backend
design would cover collapse to a single line each; the substance of this design
is the pure text builder, the platform-branch orchestrator, and the
`POsSection.tsx` wiring — all frontend.

### Data model / RLS / API contract / edge functions / realtime — NONE

- **Data model changes.** None. No migration filename is proposed; this design
  intentionally ships zero `supabase/migrations/*.sql`.
- **RLS impact.** None. No new table, no policy change. The status write rides
  spec-107's already-hardened per-store path (`markPurchaseOrderSent` →
  store-scoped `purchase_orders` UPDATE under `auth_can_see_store(store_id)`).
- **API contract.** None new. The text body is built entirely from the
  already-loaded `poLinesById[sel.id]` (spec-107's `loadPurchaseOrderLines`) +
  the already-loaded `inventory` array + `sel` header fields. **No new network
  fetch for the share text** (AC). PostgREST vs RPC is not a decision here.
- **Edge function changes.** None. `verify_jwt` settings untouched.
- **`src/lib/db.ts` surface.** None. No new helper, no snake_case→camelCase
  mapping. The builder lives in `src/utils/` (pure), and the I/O orchestrator
  lives beside `POsSection.tsx` (impure, but not a DB call). The two documented
  `db.ts` carve-outs are not relevant; nothing here touches Supabase directly.
- **Realtime impact.** None. The mark-as-sent status change already replays on
  the `store-{id}` channel via spec-107's existing path (other admin clients
  reload on the 400 ms debounce). **This spec adds no `supabase_realtime`
  publication membership change, so the publication gotcha
  (`docker restart supabase_realtime_imr-inventory`) does NOT apply** — flagged
  explicitly so the developer does not add a restart step out of habit.
- **Frontend store impact.** None. **No slice of `src/store/useStore.ts`
  changes.** No new action, no new state field. The optimistic-then-revert +
  `notifyBackendError` pattern is NOT introduced by this spec — the only store
  call (`markPurchaseOrderSentManually`) already owns its own
  refresh/error posture inside spec-107. Share/copy failures surface via
  `Toast.show` from the orchestrator (below), never via the store.

---

### D-1 — Desktop-web copy mechanism (Architect decision → RESOLVED)

**Decision: use web-only `navigator.clipboard.writeText(...)` behind the
`Platform.OS === 'web'` branch. Do NOT add the `expo-clipboard` dependency.**

Rationale:

1. **The copy path is a desktop-web-only concern.** Clipboard copy is only ever
   reached in the `Platform.OS === 'web'` **and** `navigator.share` **absent**
   branch (mobile web takes `navigator.share`; native takes `expo-sharing` and
   never touches the clipboard). So a cross-platform clipboard abstraction buys
   nothing — the one call site is provably web-only.
2. **Secure-context + user-gesture preconditions both hold.** `navigator.clipboard`
   requires a secure context (HTTPS/localhost — Vercel prod + the local dev
   stack both qualify) and the write is triggered inside the Share button's
   `onPress` (a user gesture). Both hold at this call site, so the async
   Clipboard API is the correct, non-deprecated web mechanism.
3. **The native admin build is covered without clipboard.** The admin Cmd
   surface is web-primary. On the rare native admin build, `Platform.OS !== 'web'`
   routes to `expo-sharing` (`Sharing.shareAsync`) — the OS share sheet — which
   already covers Messages/WeChat natively. **No native code path ever needs the
   clipboard**, so the sole argument for `expo-clipboard` (native coverage)
   does not apply.
4. **Dependency cost.** Adding a package for one guarded call is net-negative:
   larger `package.json` surface, an SDK-alignment obligation on every Expo
   bump, and a jest-mock surface — for a call the platform gives us free behind
   a guard we already write.

**Availability + fallback (AC "does not silently no-op").** The visible,
selectable text preview (D-3) is the **always-present** fallback and is
rendered regardless of clipboard outcome. The clipboard write is attempted as a
convenience:

```
// pseudocode — inside the desktop-web branch of the orchestrator
if (typeof navigator !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function') {
  try {
    await navigator.clipboard.writeText(text);
    successToast('copied');          // AC: success toast on copy
  } catch {
    // clipboard blocked (permission / focus) — NOT an error toast;
    // the preview pane is already on screen. Optionally a neutral
    // "copy blocked — select the text below" toast. No throw.
  }
} else {
  // navigator.clipboard unavailable — no toast-as-error; the preview
  // is the fallback. Do NOT silently succeed.
}
return { previewText: text };        // preview always rendered
```

`typeof navigator !== 'undefined'` guard keeps the module import-safe under
jest/node (where `navigator` may be undefined). No `expo-clipboard` import
anywhere. This is the one **new pattern** vs `shareReorder.ts` (which never
copies — it downloads via `webDownload`); it is justified because a text
message wants clipboard-paste, not a `.txt` file download.

---

### D-2 — Platform-branch shape (Architect decision → RESOLVED)

**Home of the impure orchestrator:** a NEW admin-local module
`src/screens/cmd/lib/sharePo.ts` (create the `src/screens/cmd/lib/` dir — it
does not yet exist; this mirrors the staff precedent
`src/screens/staff/lib/shareReorder.ts`, which is the impure sibling to the
pure `src/utils/reorderExport.ts`). It is admin-Cmd-only (the staff app gets no
share affordance — Out of scope), so it does NOT belong under `src/utils/`
(pure) nor under `src/screens/staff/`. Placing it beside `POsSection.tsx`'s
section dir keeps the one consumer close.

> Note the `src/screens/staff/` subtree is a documented `db.ts` carve-out, but
> `sharePo.ts` lives under `src/screens/cmd/`, not staff, and makes **no**
> Supabase call at all — so no carve-out question arises.

**Branch predicate order — mirror `shareReorder.ts:nativeShare` exactly, with
the web split added:**

```
export async function sharePurchaseOrder(
  text: string,
  opts: { dialogTitle: string; onCopyToast: () => void; onCopyBlocked?: () => void },
): Promise<{ previewText: string | null }> {
  try {
    if (Platform.OS !== 'web') {
      // ── native: expo-sharing OS share sheet ──
      // Mirror shareReorder.ts: check availability BEFORE writing any temp file.
      const available = await Sharing.isAvailableAsync();
      if (!available) throw new Error('Sharing is not available on this device');
      // A text message has no file artifact. Two acceptable shapes; pick ONE
      // and pin it in the build (see "native text handoff" below):
      //   (a) write a temp .txt to Paths.cache + Sharing.shareAsync(file.uri)
      //       — identical to shareReorder.nativeShare; shares a file, not a body.
      //   (b) Sharing.shareAsync does NOT take a raw string; a text-only share
      //       on native requires RN's `Share.share({ message: text })`.
      // DECISION: use RN `Share.share({ message: text })` on native for a
      // message body (no stray .txt in the vendor's chat). expo-sharing is
      // file-oriented; a PO text message is a body, so `Share` from
      // 'react-native' is the honest primitive. `Sharing.isAvailableAsync()`
      // is still the availability gate we mirror from the precedent; if you
      // prefer to keep the expo-sharing symmetry, (a) is acceptable but ships
      // a file. Frontend dev picks (a) xor (b) and pins it in a test comment.
      return { previewText: null };
    }
    // ── web ──
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      // mobile web (Safari/Chrome Android share API present)
      await navigator.share({ text });   // AC: navigator.share({ text })
      return { previewText: null };
    }
    // desktop web (navigator.share absent) — clipboard + visible preview (D-1/D-3)
    await copyToClipboard(text, opts);    // the D-1 pseudocode
    return { previewText: text };         // caller renders the preview pane
  } catch (err) {
    failureToast(err);                    // mirror shareReorder failureToast; NEVER throw
    return { previewText: null };
  }
}
```

Predicate order, matching `shareReorder.ts`'s `Platform.OS === 'web'` gate but
splitting web into two sub-cases:

1. `Platform.OS !== 'web'` → native share (`Sharing.isAvailableAsync()` gate,
   then hand off the text — see native decision above).
2. `Platform.OS === 'web'` **and** `navigator.share` present → `navigator.share({ text })`.
3. `Platform.OS === 'web'` **and** `navigator.share` absent → clipboard (D-1) +
   preview (D-3).

**Error posture — mirror `shareReorder.ts` verbatim:** wrap the whole thing in
`try/catch`, route failures to a `failureToast` (`console.warn` +
`Toast.show({ type: 'error', position: 'bottom' })`), and **never throw to the
caller** (AC "never throw to the caller — same posture as `shareReorder.ts`").
The `navigator.share` `AbortError` (user dismissed the share sheet) should be
swallowed as a non-error (not a failure toast) — a dismissed share is a no-op,
identical in spirit to declining the mark-as-sent prompt.

**`onShareComplete` signal for the mark-as-sent prompt.** The orchestrator
resolves only after the share/copy step settles. The **return** (a resolved
promise that did not throw) is the "completed share/copy" signal the caller uses
to fire the draft-only prompt (D-4). Do NOT fire the prompt on the
`AbortError`/dismiss path — resolve with a discriminator the caller can read, or
throw-and-catch internally so the caller's `.then(prompt)` does not run on
dismiss. Simplest shape: resolve `{ previewText, shared: boolean }` and gate the
prompt on `shared === true`. **Pin this in a test** (re-share suppression +
dismiss-no-prompt).

---

### D-3 — Desktop-web preview: where it lives (RESOLVED)

**Decision: an inline preview pane inside the PO detail's `order.tsx` tab, NOT a
modal.** It renders only in the desktop-web branch (i.e. only when
`sharePurchaseOrder` returns a non-null `previewText`), directly under the
action row / header block, as a bordered `C.panel` card matching the existing
detail cards (same `CmdRadius.lg` + `borderColor: C.border` treatment the lines
table and StatCards already use in `POsSection.tsx`).

Rationale for inline over modal:
- `POsSection.tsx` has **no existing modal pattern** — the detail pane is a
  `ScrollView` of stacked cards. Introducing a modal is a new pattern with no
  precedent in this section; an inline card matches what's there.
- The preview is a fallback aid ("copy failed? select this"), not a blocking
  step — a modal would over-dramatize it and trap focus for a convenience.
- `confirmAction` (used for the D-4 prompt) is the section's only
  dialog-shaped affordance and is already cross-platform; the preview is
  content, not a decision, so it stays inline.

Shape: a monospace, **user-selectable** `<Text selectable>` block (RN Text on
web renders selectable text; ensure `selectable` is set) containing the exact
`previewText`, with a `testID="po-share-preview"` and a small caption label
(i18n key `sharePreviewLabel`). It persists until the next share or PO switch
(clear `previewText` state when `selectedId` changes). No dismiss button needed
in v1 (it's inert, selectable content); if the dev wants one, a small "×"
matching the line-delete affordance is fine but not required.

---

### D-4 — The pure text builder (Architect decision → RESOLVED)

**Filename: `src/utils/poShareText.ts`** (mirrors the `reorderExport.ts`
precedent — pure, framework-free, no React/theme/supabase, jest-covered). It
imports **only** `formatQty` from `./reorderExport` (the AC-mandated reuse) and
its own types. It does NOT import `getLocalizedName`, the store, or i18n — name
resolution is injected as a callback so the builder stays pure (the caller
closes over `inventory` + `locale`).

**Input shape (single PO):**

```
export interface PoShareLine {
  itemId: string;      // PoLine.itemId (= inventory_items.id) — the resolver key
  orderedQty: number;  // PoLine.orderedQty
  unit: string;        // PoLine.unit
  // NOTE: costPerUnit / receivedQty are intentionally NOT part of this shape.
  // No money enters the builder (AC: no formatMoney here, no $ in output).
}

export interface PoShareInput {
  storeName: string;        // sel/currentStore — header line
  referenceDate: string;    // (sel.date || '').slice(0,10) — header line
  lines: PoShareLine[];     // mapped from poLinesById[sel.id]
}

// Injected resolver — keeps the builder pure of store/i18n. The CALLER passes
// (itemId) => getLocalizedName(inventory.find(i => i.id === itemId), locale),
// with the plain-English PoLine.itemName as the fallback when no inventory row
// is found (defensive — the line should always have a matching inventory row).
export type NameResolver = (itemId: string, fallbackName: string) => string;

export function buildPoShareText(
  input: PoShareInput,
  resolveName: NameResolver,
): string { /* pure */ }
```

The caller (in `POsSection.tsx`) builds the resolver from the already-loaded
`inventory` array + `useLocale()`:

```
// pseudocode at the call site — NOT part of the pure builder
const resolveName: NameResolver = (itemId, fallbackName) => {
  const row = inventory.find((i) => i.id === itemId);
  return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale)
             : fallbackName;   // PoLine.itemName (plain English) as last resort
};
```

This resolves OQ-2 exactly: current-locale name re-resolved against the
`inventory` row's `i18nNames` (because `PoLine.itemName` is a plain-English
string only), with **per-item English fallback** (the `getLocalizedName` silent
fallback when a locale is missing + the `fallbackName` when no inventory row is
found). `InventoryItem.id === PoLine.itemId === inventory_items.id` (verified:
`mapItem` sets `id: row.id`, `mapPoItemRow` sets `itemId: r.item_id`), so the
`.find` key is exact.

**Output template (pin this — jest-testable, byte-for-byte):**

```
I.M.R — Purchase order
Store: {storeName}
Date: {referenceDate}

{qty} × {unit} {name}     ← one line per PO line, in poLinesById order
{qty} × {unit} {name}
...

{N} items
```

- Header block: line 1 a fixed label (`I.M.R — Purchase order` — the vendor-
  facing brand string; mirrors `buildReorderText`'s `I.M.R — Reorder list`
  header), line 2 `Store: {storeName}`, line 3 `Date: {referenceDate}`, then a
  blank line. (**AC header = store name + reference/order date.**)
- Body: **one line per item**, `` `${formatQty(orderedQty)} × ${unit} ${name}` ``
  → e.g. `3 × case Chicken Thigh`. `formatQty` reused from `reorderExport.ts`
  (AC). The `×` (U+00D7 multiplication sign) is deliberate and matches the AC's
  "quantity × unit × item name" phrasing; pin it exactly in the test. `.trim()`
  each line so an empty `unit` doesn't leave a double space
  (`` `${formatQty(q)} × ${unit} ${name}`.replace(/\s+/g, ' ').trim() `` or
  build parts + `.filter(Boolean).join(' ')` — dev picks, pin in test).
- A blank line, then the trailing **line count**: `` `${lines.length} items` ``
  (AC "e.g. '5 items'"). Use the raw count; do NOT pluralize-branch in v1 (the
  AC example is bare `N items` — keep it locale-agnostic and simple; the count
  string is NOT run through i18n because the shared text is a vendor-facing
  artifact whose header label is a fixed brand string, consistent with
  `buildReorderText` which is also not localized. **This is a deliberate scope
  call: the SHARED TEXT is not localized chrome; only the ITEM NAMES localize,
  per OQ-2.** If the PM wants the "items" word localized, that's a follow-up —
  flag, do not invent.)
- **NO dollar amounts anywhere** (AC). The builder never receives money
  (`PoShareLine` has no cost field) and never imports `formatMoney`. A jest test
  asserts the output contains no `$`.

**Empty-lines edge case (AC "empty-lines edge"):** when `lines.length === 0`,
emit the header block, then `(no items)` in place of the body, then `0 items`.
Pin this in a test. (Draft POs can transiently have zero lines mid-edit; the
share button is still exposed, so the builder must be total.)

Example the jest test pins (en locale, resolver returns names verbatim):

```
Input:  { storeName: 'Towson', referenceDate: '2026-07-03',
          lines: [ {itemId:'a', orderedQty:3, unit:'case'},
                   {itemId:'b', orderedQty:12, unit:'lb'} ] }
resolveName: (id) => id==='a' ? 'Chicken Thigh' : 'Yellow Onion'

Output (exact):
I.M.R — Purchase order
Store: Towson
Date: 2026-07-03

3 × case Chicken Thigh
12 × lb Yellow Onion

2 items
```

---

### D-5 — Wiring points in `POsSection.tsx` (RESOLVED)

All wiring is in `src/screens/cmd/sections/POsSection.tsx`. New store imports:
`inventory` (`useStore((s) => s.inventory)`) and `useLocale()` — both already
used by sibling sections (`InventoryCatalogMode.tsx`), no new store surface.

**(a) Share button — primary/accent, in the `TabStrip` `rightSlot` action
row.** Add a `po-action-share` button as the FIRST (leftmost) item in the
existing `rightSlot` `<View>` (the row that today holds
`po-action-send` / `po-action-mark-sent` / `po-action-close-short` /
`po-action-cancel`). Share carries the **accent** styling
(`backgroundColor: C.accent`, `color: '#000'`, `mono(700)`) — the same treatment
`po-action-send` uses today. Per AC, Share is now the **primary** action.

Visibility predicate: `const canShare = ['draft', 'sent', 'partial'].includes(selStatus);`
(AC: draft + sent + partial; `received`/`cancelled` show no Share). Add
`testID="po-action-share"`, `disabled={busy}`, `opacity: busy ? 0.5 : 1`.

**(b) Email demoted to secondary when present.** Today `po-action-send` uses
accent styling. Per AC, when `vendorEmail` is present the email send button
**remains but becomes secondary** (the outlined `borderWidth: 1,
borderColor: C.borderStrong, color: C.fg2` treatment that `po-action-mark-sent`
uses today). Its `canSend && vendorEmail` gate is UNCHANGED (spec 107). Only its
styling demotes from accent → outlined. `po-action-mark-sent` stays as-is
(already secondary/outlined). Net: exactly one accent button (Share); email +
mark-sent are outlined secondaries.

**(c) Repointed no-email hint.** The existing `po-no-email-hint` (rendered when
`canSend && !vendorEmail`) is **repointed to nudge toward Share** — swap the
i18n key from `noEmailHint` to a new `noEmailShareHint` (D-6). Keep the same
`testID="po-no-email-hint"`, same `C.warn` styling, same render condition. Only
the string changes. (The old `noEmailHint` key stays in the catalog — it's still
referenced nowhere else, but leave it to avoid churn; OR repoint in place. Dev
picks; the AC only requires the *hint text* points at Share.)

**(d) The onShare handler + the auto-prompt.** New handler `onShare`:

```
// pseudocode — POsSection.tsx
const onShare = async () => {
  if (!sel || busy) return;
  const lines = poLinesById[sel.id] || [];
  const resolveName: NameResolver = (itemId, fallbackName) => {
    const row = inventory.find((i) => i.id === itemId);
    return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale)
               : fallbackName;
  };
  const text = buildPoShareText(
    { storeName: currentStore.name, referenceDate: (sel.date || '').slice(0, 10),
      lines: lines.map((l) => ({ itemId: l.itemId, orderedQty: l.orderedQty, unit: l.unit })) },
    resolveName,
  );
  const { previewText, shared } = await sharePurchaseOrder(text, {
    dialogTitle: T('section.purchaseOrders.shareDialogTitle'),
    onCopyToast: () => Toast.show({ type: 'success', text1: T('section.purchaseOrders.copiedToast') }),
  });
  setSharePreview(previewText);                 // D-3 inline preview (desktop web)
  // AC: auto-prompt ONLY on a draft, ONLY after a completed share/copy.
  if (shared && selStatus === 'draft') {
    confirmAction(
      T('section.purchaseOrders.didYouSendTitle'),
      T('section.purchaseOrders.didYouSendBody', { vendor: sel.vendorName }),
      () => {
        setBusy(true);
        void markPurchaseOrderSentManually(sel.id)
          .then((ok) => { if (ok) Toast.show({ type: 'success', text1: T('section.purchaseOrders.markedSentToast') }); })
          .finally(() => setBusy(false));
      },
      T('section.purchaseOrders.didYouSendCta'),
    );
  }
};
```

Key invariants (all AC):
- **The prompt reuses the EXISTING `markPurchaseOrderSentManually(sel.id)`
  action** — the same confirm-gated PostgREST status update + audit row spec 107
  ships. **No new store action.** (Note: `confirmAction` IS the confirm gate, so
  this is confirm-gated by construction — same shape as the existing `onMarkSent`
  handler, whose `.then/.finally/toast` block is reused verbatim.)
- **Status never auto-flips without the prompt.** Declining the `confirmAction`
  is a no-op → status stays `draft` (AC).
- **Prompt suppressed when `selStatus !== 'draft'`** (the `shared && selStatus === 'draft'`
  gate). Sent/partial re-share is a **reminder with no status change and no
  prompt** (AC / OQ-4). Prompting to "mark as sent" an already-sent PO is
  nonsensical — suppressed.
- **Prompt does not fire on share-sheet dismiss** (`shared === false` from the
  `AbortError` path, D-2).
- The `markedSentToast` string is reused from spec 107 (already in the catalog);
  no new toast key for the outcome.

**(e) Preview state.** `const [sharePreview, setSharePreview] = React.useState<string | null>(null);`
Clear it in the existing `selectedId`-change `useEffect` (or add a small effect):
`React.useEffect(() => setSharePreview(null), [selectedId]);` so a stale preview
from PO A doesn't linger when switching to PO B. Render the D-3 inline card when
`sharePreview != null`.

---

### D-6 — i18n keys (RESOLVED — en / es / zh-CN, all three)

New keys under `section.purchaseOrders.*` (matching the existing spec-107 key
style in that block). zh-CN matters — WeChat users are the primary audience for
this feature; the zh translations must read naturally, not machine-literal.
Minimum key set (the AC enumerates: button label, share-sheet dialog title,
toast text, the "Did you send it?" prompt, preview label, repointed no-email
hint):

| Key | en (reference) |
|---|---|
| `section.purchaseOrders.shareAction` | `SHARE PO` |
| `section.purchaseOrders.shareDialogTitle` | `Share purchase order` |
| `section.purchaseOrders.copiedToast` | `Copied — paste into Messages or WeChat` |
| `section.purchaseOrders.didYouSendTitle` | `Did you send it?` |
| `section.purchaseOrders.didYouSendBody` | `Did you send this purchase order to {vendor}? If you sent it, mark it as sent. If you didn't, this stays a draft.` |
| `section.purchaseOrders.didYouSendCta` | `Mark as sent` |
| `section.purchaseOrders.sharePreviewLabel` | `Shared text — select to copy` |
| `section.purchaseOrders.noEmailShareHint` | `No vendor email on file — use Share to text or WeChat this order to the vendor.` |

**The honest-prompt wording is load-bearing (AC / OQ-3):** the title is a
QUESTION (`Did you send it?`), never an assertion, and the body explicitly states
that declining leaves it a draft. Web share/copy cannot confirm an actual send —
the wording must not imply the app knows. Keep the interrogative in all three
locales (do not let a translator turn it into an imperative). Reuse the existing
`markedSentToast` for the success outcome (do not add a new outcome toast).

---

### Risks and tradeoffs

- **`navigator.share` presence ≠ it will succeed.** Some desktop browsers now
  expose `navigator.share` but reject non-file text shares or require flags. The
  `try/catch` + `failureToast` + (on desktop-web) the preview pane cover this;
  but a desktop Chrome that has `navigator.share` will take branch (2) and NOT
  render the preview. Accept for v1 (matches AC's `navigator.share`-present →
  `navigator.share` decision); if field reports show desktop `navigator.share`
  failing without the preview fallback, a follow-up can render the preview on
  the web path unconditionally. **Flagged, not fixed.**
- **`Sharing.shareAsync` vs RN `Share` on native.** The precedent
  (`shareReorder.ts`) shares a *file* via expo-sharing; a PO *text message* is a
  body, better served by RN `Share.share({ message })`. The design picks RN
  `Share` for native but leaves the expo-sharing file path as an acceptable
  alternative — the frontend dev must pin ONE in a code comment + not leave both.
  The native admin build is rare (web-primary surface), so this path is
  low-traffic; still, it must not throw (AC). Availability gating mirrors the
  precedent regardless of which primitive is chosen.
- **`inventory.find` per line is O(lines × inventory).** For a PO with a few
  dozen lines against the 286 KB seed's inventory (hundreds of rows) this is
  trivial (sub-millisecond, one-shot on button press, not per-render). No memo
  needed; if a future PO has hundreds of lines, hoist a `Map<id,row>` — not
  warranted now. **Flagged as non-issue for the seed dataset.**
- **No edge function → no cold-start concern.** Nothing here hits an edge
  function; the mark-as-sent write rides spec-107's existing PostgREST path.
- **The shared text is NOT localized chrome.** Only item names localize (OQ-2).
  The header label + `N items` are fixed English brand strings (consistent with
  `buildReorderText`). This is a deliberate scope boundary; if the PM later
  wants the shared body fully localized, it's a follow-up, not silent scope
  creep. **Flagged.**
- **Migration ordering / RLS gaps:** N/A — zero migrations, zero policy changes.
- **Preview persistence across PO switch:** the `setSharePreview(null)` on
  `selectedId` change is the guard; without it a stale preview leaks between POs.
  Called out as a required detail, not optional.

### Open question surfaced to PM (non-blocking)

- **Should the shared body's fixed strings (`I.M.R — Purchase order`, `Store:`,
  `Date:`, `N items`) be localized, or stay English?** This design keeps them
  English (item names localize per OQ-2; the body mirrors `buildReorderText`'s
  un-localized shared-artifact posture). If the owner's WeChat vendors would
  prefer a fully-Chinese message body, that is a small follow-up (localize the
  builder's fixed strings via an injected label bundle, keeping the builder
  pure). Not blocking v1 — flagged per the "push back on the spec" rule so the
  scope call is explicit and owner-visible rather than silently invented.

---

## Implementation notes (frontend-developer)

### Resolution of the flagged open question — the shared body IS fully localized
The design surfaced "should the shared body's fixed strings stay English?" as a
non-blocking open question. Per the main-Claude ruling at build time, this was
resolved TOWARD localization: **the whole message follows the current app
language.** OQ-2 already localizes the item names to the current app locale; a
mixed English-chrome / Chinese-item-names message to a WeChat vendor reads
broken. So the FIXED strings — the header brand line, the `Store` / `Date`
labels, and the trailing `N items` count — ALSO localize.

The pure builder stays pure: it takes those strings **pre-resolved** as a
`labels` bundle (plain strings, NOT a `t()` import). The CALLER
(`POsSection.onShare`) resolves each via `T()` in the current app locale and
passes them in. This is the ONE deliberate extension vs the design's D-4 shape:
`buildPoShareText(input, labels, resolveName)` — a `labels` param was added
between `input` and `resolveName`. New i18n keys for the body strings
(`shareBodyHeader`, `shareBodyStoreLabel`, `shareBodyDateLabel`,
`shareBodyItemsCount`, `shareBodyNoItems`) landed in all three locales
alongside the D-6 keys.

### Native primitive pinned (D-2 decision (b))
`sharePo.ts` uses RN `Share.share({ message })` on native — the honest
text-body primitive — NOT `expo-sharing`'s file-oriented `shareAsync` (which
would leave a stray `.txt` in the vendor's chat). `Sharing.isAvailableAsync()`
is still the pre-flight availability gate, mirroring `shareReorder.ts`. Pinned
in a module comment and a jest test.

### Two supporting mechanical changes (flagged for review)
- **`jest.config.js` testMatch extension.** The `unit` (node-env) project's
  `testMatch` gained `<rootDir>/src/screens/cmd/lib/**/*.test.ts` so the pure-TS
  orchestrator test (`sharePo.test.ts`) actually runs. This is the exact
  sibling of the pre-existing `src/screens/staff/lib/**/*.test.ts` carve-out
  (spec 063) — not a new framework, just extending an existing jest project's
  glob to cover the admin-Cmd `lib/` dir the design pinned as the orchestrator's
  home.
- **`po-list-{id}` testID on the PO list-row `TouchableOpacity`.** Added so the
  "preview clears on PO switch" test can press a specific row deterministically.
  Consistent with the section's existing testID usage (`po-filter-*`,
  `po-action-*`, `po-line-*`).

### Verification
- FULL `npx jest`: 82 suites / 896 tests green.
- Base typecheck `npx tsc --noEmit`: clean.
- Test-graph typecheck `npx tsc -p tsconfig.test.json --noEmit`: clean.
- Browser preview tools were NOT available in the implementing session; the
  `POsSection.test.tsx` full-render `@testing-library/react-native` coverage
  (golden path + edge cases: share→prompt→mark-sent, re-share suppression,
  dismiss-no-prompt, primary/secondary emphasis, clipboard-fallback preview
  renders + clears on PO switch) plus both typechecks stand in. Main Claude runs
  the browser pass.

## Files changed
- `src/utils/poShareText.ts` (new) — pure builder; `PoShareLine` /
  `PoShareInput` / `PoShareLabels` / `NameResolver` + `buildPoShareText`.
- `src/utils/poShareText.test.ts` (new) — builder unit coverage.
- `src/screens/cmd/lib/sharePo.ts` (new) — impure platform-branch orchestrator.
- `src/screens/cmd/lib/sharePo.test.ts` (new) — orchestrator branch coverage.
- `src/screens/cmd/sections/POsSection.tsx` — Share wiring (primary action,
  email demoted to outlined secondary, hint repointed to `noEmailShareHint`,
  `onShare` + draft-only prompt, inline preview pane, `po-list-{id}` testID).
- `src/screens/cmd/sections/__tests__/POsSection.test.tsx` — Share-flow tests +
  store-mock `inventory` + new module mocks.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — new
  `section.purchaseOrders.*` keys (D-6 + the localized body strings).
- `jest.config.js` — unit project `testMatch` gains
  `src/screens/cmd/lib/**/*.test.ts`.
