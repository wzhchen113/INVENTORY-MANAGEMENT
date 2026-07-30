## Code review for spec 148 (Phone tier — Login / Notifications / Store & brand switch)

Reviewed: `PhoneLogin.tsx`, `PhoneNotifications.tsx`, `PhoneStoreSwitch.tsx`,
`LoginScreen.tsx` guard + model lift, `ResponsiveCmdShell.tsx` phone branch,
`MobileNavDrawer.tsx` additive `storeChip` slot, the three new test files, and
the i18n catalogs.

### Critical
None found.

### Should-fix
None found. The `LoginScreen.tsx` guard (`:135`) is placed after every hook
with no hooks following it; `ResponsiveCmdShell.tsx`'s phone branch
(`:398-450`) only touches the `isPhone` block, leaving the tablet/desktop
branches below untouched; `MobileNavDrawer`'s new `storeChip` prop is optional
and additive (`:27`, rendered conditionally at `:90`), so existing callers
without it are unaffected. `PhoneNotifications` reuses
`feedHasUnreadMissed`/`badgeBackgroundColor`/`badgeTextColor`/`rowDotColor`
from `NotificationBell` verbatim rather than re-deriving the spec-121 badge
rule, and `PhoneStoreSwitch`'s access filtering (`isAdmin ? stores :
stores.filter(...)`, then narrowed to `currentBrandId`) matches the described
`TitleBar` store-switcher logic.

### Nits
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx` appears in `git status` as
  modified in this batch (a comment-only note about file-tab-strip removal at
  `:245-247`) but is not listed under any of specs 143-148's "Files changed"
  sections. It's a comment-only, no-op-looking change, so low risk, but worth
  a one-line confirmation of which spec actually owns it so the paper trail
  stays complete — a reviewer diffing spec-to-commit later has no doc to point
  at for this file.
- `src/screens/cmd/sections/phone/PhoneLogin.tsx:245` — `u.color` (the demo
  quick-login avatar/role-label tint) is consumed as a raw string with no
  token indirection. This is not a new violation — `LoginScreen.tsx` already
  renders the identical `u.color` value directly in the desktop demo-account
  list (`:248`, `:257`) — but since `PhoneLogin` is new code it was a
  reasonable spot to note the debt is inherited rather than introduced.
- The shared-pre-auth-portal deviation (phone login restyle necessarily
  reaching the staff surface, since role is unknown pre-`signIn`) is disclosed
  in the spec and is a legitimate product/UX call, not a code defect — noting
  it here only to confirm the code review has no objection to how it's
  implemented (a clean `isPhone`-only gate, no attempted and-failed role
  check).

Overall: no direct Supabase calls, no hardcoded hex outside the pre-existing
demo-user color debt noted above, no `Alert.alert`/`window.confirm`. The
notifications sheet's PUSH toggle correctly reuses `useNotificationToggle`
rather than re-deriving enable/disable state, and the store/brand switch
correctly funnels through the existing `setCurrentStore` / `setCurrentBrandId`
actions (the spec-111 takeover triggers) rather than a new state path.

## Handoff
next_agent: NONE
prompt: Code review complete for spec 148. 0 Critical, 0 Should-fix, 3 Nits.
payload_paths:
  - specs/148-phone-shell-trio/reviews/code-reviewer.md
