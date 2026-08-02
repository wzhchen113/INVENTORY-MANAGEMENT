# Code review for spec 149

Scope covered: every file listed under the spec's `## Files changed` (frontend
+ backend halves), cross-checked against the ACs, `## Backend design`, the
"Backend/Frontend deviations" notes, and the AC-REG freeze group. This is an
unusually clean, well-documented implementation — most of the review consisted
of confirming that self-flagged deviations are handled the way the notes say
they are. No architecture or security findings included below (deferred to
backend-architect / security-auditor).

### Critical

None found.

- AC-REG freezes verified byte-for-byte: `PhoneOrdering.tsx`'s `LineStepper` /
  `VendorOrderCard` are exported with an additive `footer` prop defaulting to
  `'default'` — the `PhoneOrdering` render path is unchanged
  (`src/screens/cmd/sections/phone/PhoneOrdering.tsx:84-476`).
  `ReorderSection.tsx`'s phone fork reads `pendingApproval` with the other
  hooks, above the `isPhone` guard (`src/screens/cmd/sections/ReorderSection.tsx:1332,1470-1477`),
  and desktop/tablet never set `orderApproval` so the desktop tree is
  unreachable through the new code path — confirmed by
  `PhoneApproveOrder.acReg.test.tsx`.
- `NotificationBell.tsx`'s four exported helpers (`feedHasUnreadMissed`,
  `badgeBackgroundColor`, `badgeTextColor`, `rowDotColor`) are not in the
  Files-changed list and are imported unmodified by `PhoneNotifications.tsx` —
  AC-4/AC-REG-4 holds.
- No client-side `fetch`/reference to `connect.instacart.com` or the API key
  anywhere under `src/` — the only match is a comment in `db.ts:2336-2337`
  documenting the rule (AC-22 clean).
- `mintInstacartCartLink` (`src/lib/db.ts:2574-2625`) uses
  `supabase.functions.invoke`, the documented exception to `callEdgeFunction`
  for when structured error bodies are needed — matches the `fetchBreadbotSales`
  precedent and is explicitly justified in the doc comment (AC-25).
- `instacart-cart-link/index.ts` defines `ADMIN_ROLES` + inline
  `requireAdminCaller()` mirroring `delete-user`'s shape, gates before any
  upstream call, reads every request-path row through a caller-token client so
  RLS (not a service-role trust check) enforces AC-24, and never logs/echoes
  the key (AC-22/23/24/26 all satisfied; `escapeHtml()` correctly not present
  — JSON-only).
- Migrations are strictly additive, applied in the documented dependency
  order, and the RLS/permissive-policy-lint reasoning in
  `20260801000100_order_approvals.sql` is correct — `auth_is_privileged()` is
  load-bearing on all three policies, no allowlist entry needed.

### Should-fix

- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx:541-549` —
  `openInNewContext` (used by RE-OPEN LINK) calls `Linking.openURL(url)` on
  native with **no `.catch`**, unlike its near-duplicate
  `openExternalOrderUrl` in `src/store/useStore.ts:61-67`, which does
  `.catch((e) => notifyBackendError('Open order page', e))`. A failed native
  `Linking.openURL` (e.g. no app registered for the scheme) becomes an
  unhandled promise rejection with zero user feedback here, whereas the
  primary APPROVE & ORDER path surfaces the same failure correctly. Either
  add the same `.catch(notifyBackendError(...))`, or extract both copies into
  one shared `src/utils/openExternalUrl.ts` (the project already does this
  kind of extraction for `resolveOrderChannel` / `poCaseDisplay`) so the two
  call sites can't drift on error handling again.

### Nits

- `src/lib/db.ts:2494-2522` (`advanceOrderApproval`) — a PostgREST `UPDATE`
  that RLS silently reduces to 0 affected rows returns `null` with no
  `error` (`.maybeSingle()` on an empty result set doesn't throw). Every
  caller in `useStore.ts`'s `approveAndOrder` branches on `if (updated) set(...)`
  with no `else`, so a 0-row update after a successful external action (link
  opened / cart filled / text shared) would silently leave `approval` stale
  with no toast. Very unlikely in practice (the row was just created under
  the same session/store), but worth a one-line `else notifyBackendError(...)`
  if this is ever seen in the wild — not blocking.
- `src/lib/db.ts:2570-2571` — the `fetchBreadbotSales` `ctx?.error` dead
  branch (pre-existing, `db.ts:2765`) is correctly called out in the spec's
  "Frontend deviations" notes as a known-latent, out-of-scope bug rather than
  silently left undocumented. No action needed here; flagging only to
  confirm the review caught it and agrees it's out of scope for this spec.
- `src/components/cmd/StoreFormDrawer.tsx` / spec deviation note 2 — postal
  code has no edit surface on existing stores (create-only drawer). This is
  self-flagged in the spec's "Frontend deviations" section with the correct
  safe-default consequence (Instacart channel stays dark for existing
  stores). No code issue; a follow-up spec item, not a review finding.
- `supabase/functions/instacart-cart-link/index.ts` — very long single
  `Deno.serve` handler (~260 lines) with sequential gate checks. Readable
  given the heavy inline commenting and the "everything before the upstream
  call must be checked in a specific order" constraint from the design, but
  a future spec touching this function would benefit from splitting the
  gate/validate/mint/write-back phases into named helper functions purely
  for scannability. (out-of-scope) — not asking for a rewrite here.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 4 Nits.
payload_paths:
  - specs/149-eod-approve-order-pipeline/reviews/code-reviewer.md
