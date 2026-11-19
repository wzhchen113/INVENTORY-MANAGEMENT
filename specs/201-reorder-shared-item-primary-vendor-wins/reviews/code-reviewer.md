## Code review for spec 201

Scope: frontend files (`useStore.ts` action, `primaryVendorSwitch.ts`, ReorderSection, PhoneOrdering, staff Reorder, i18n) plus a read of the new `set_item_primary_vendor` migration and the two `db.ts` helpers. I could not run `git diff --cached` (no shell in this session), so I read the files as they sit in the tree. I did not re-verify migration 1's "verbatim baseline" claim line by line or read the new test files; the architect and test-engineer cover those.

### Critical
- None.

### Should-fix
- `src/screens/cmd/sections/ReorderSection.tsx:1130-1163` and `src/screens/cmd/sections/phone/PhoneOrdering.tsx:536-569` (plus `ReorderSection.tsx:709-728` and `PhoneOrdering.tsx:206-228`) — The "switch" state and handler are copy-pasted across the two tiers. Both carry the same `switchingItemId` state, the same `onSwitchPrimary` body (with the same `reorderAsOfDate.slice(0, 10)` and `vendor.vendorName || ''`), and the same per-target button markup. The new `primaryVendorSwitch.ts` helper dedupes only the confirm and toast half. The helper was introduced specifically so the two tiers cannot drift, and the surrounding handler is exactly the part that will. Suggested fix: add a small hook beside the helper, e.g. `usePrimaryVendorSwitch(vendor)`, that returns `{ onSwitch, switchingItemId, canSwitch }`. Keep the per-tier JSX, since the styling differs.
- `src/store/useStore.ts:2646-2663` (optimistic patch and `revert`) — On failure the revert restores the whole pre-switch `prev` row (`map(i => i.id === itemId ? prev : i)`), which would clobber any realtime update to that item that landed during the await. The existing `updateItem` revert has the same shape, so this is consistent with the project pattern, not a bug. Worth considering only if you want it narrower: revert just `vendorId` and `vendors[].isPrimary`. I'm leaving it as a should-fix-or-accept call for the owner.

### Nits
- `src/screens/cmd/sections/ReorderSection.tsx:1120-1163`, `PhoneOrdering.tsx:526-571`, `staff/screens/Reorder.tsx:284-290` — `item.yieldedFromVendors ?? []` is evaluated up to four times per row. Hoist it to a `const yielded = item.yieldedFromVendors ?? []` inside the map callback; `many` then becomes `yielded.length > 1` computed once, not per target.
- `src/screens/cmd/sections/ReorderSection.tsx:1106-1113` and `src/screens/staff/screens/Reorder.tsx:273-278` — The retained spec 102 comments still say the hint is "advisory only — does not change which card the item is on" and that the item "appears under each of their cards". The new spec 201 paragraph right below contradicts this on coincident days. Trim the old sentence to "on non-coincident days".
- `src/screens/cmd/lib/primaryVendorSwitch.ts:19` — The local `Translate` type duplicates whatever `useT()` returns. If `useT` exports its return type, import it, so the helper does not silently diverge from `T`'s signature.
- `src/screens/cmd/lib/primaryVendorSwitch.ts:62` and `src/i18n/*.json` `section.reorder.switchRefused` — The copy says "today's {from} order", but the refusal is keyed to the as-of date on screen, which can be a past or future date. Consider "the {from} order for this date" (all three locales).
- `ReorderSection.tsx:722` and `PhoneOrdering.tsx:222` — `vendorName: vendor.vendorName || ''` feeds the confirm copy. If the name is ever empty, the dialog reads "instead of  at this store". Falling back to a generic label would read better. Low likelihood.
- `src/store/useStore.ts:2627` — `new Error('No active store')` is built only to feed `notifyBackendError`. This matches how other actions in the file report a missing-store condition, so it's fine, just noting it.
- `src/screens/staff/i18n/*.json` `reorder.item.yieldedFrom` — The en "also from {vendors} — order it here" is the right call. Staff get no switch, so the bare text read as incomplete. Two things for the owner to confirm: (a) es "pídalo aquí" uses formal usted, and I did not check it against the other es staff strings; (b) the admin line has no "order it here", which is correct since admins have a switch.

### Notes on the points the developers flagged
- **Approve Order text-only line (judgement call 1).** I agree with the choice. A switch on `footer='none'` would move the item off the order being approved. The gate is a single `allowPrimarySwitch = footer === 'default'` flag (`PhoneOrdering.tsx:215`), so it is easy to flip. Keep it. It would be good to have the architect fold this into design §9 so the spec matches the code.
- **Staff wording (judgement call 2).** Acceptable, with the es check above.
- **`primaryVendorSwitch.ts`.** Clean: it has a single responsibility, no color or platform literals, `confirmAction` is routed correctly, and both the cancel and dismiss paths resolve false so the Promise cannot hang. The store still owns write, revert, and notify. The helper's file header comment explains why, not what. The only gap is the duplicated handler noted under Should-fix.

### Project-convention checks (all clean)
- No `supabase.from` or `rpc` outside `db.ts`: `isItemOnOpenOrder` and `setItemPrimaryVendor` are in `db.ts`, both wrapped in `useInflight.track` and throwing raw errors.
- The store action follows optimistic then revert plus `notifyBackendError`. The 3c backstop deliberately skips the toast and returns `'refused'`, which the caller toasts once. The pre-check fails closed.
- No inline color literals (`C.fg3`, `C.accent` via `useCmdColors`). No direct `Alert.alert` or `window.confirm`. No web-only APIs. No `any` suppression beyond the `catch (e: any)` already idiomatic in this store.
- New realtime channels: none. Test files follow the `*.specNNN.test.*` pattern used elsewhere in `src/store/`. i18n keys are identical across en, es and zh-CN, and staff and admin catalogs are kept separate.
- `set_item_primary_vendor` migration: invoker, `search_path`, ACL, guard order and stable strings all match design §5, with the guards firing before any write. It uses `auth_is_privileged()` / `auth_can_see_store()` helpers, not custom `current_setting('jwt...')`.
- No edits to deleted legacy files and no `app.json` change.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 7 Nits.
payload_paths:
  - specs/201-reorder-shared-item-primary-vendor-wins/reviews/code-reviewer.md
