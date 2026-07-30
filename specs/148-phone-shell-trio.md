# Spec 148: Phone tier for the shell trio — Login / Notifications / Store & brand switch

Status: READY_FOR_REVIEW

> Final increment of the admin-console phone-optimization program (specs
> 140/142/143/144/145/146/147) driven by the external design handoff
> (`design_handoff_imr_phone`, README §19 Login, §20 Notifications, §21 Store &
> brand switch). Specs 143–147 covered the section screens; this spec completes
> the phone screen list with the three global **shell** surfaces that are not
> sidebar sections: the pre-auth **Login**, the notifications-feed **sheet**
> behind the bar bell, and the **store & brand switch** sheet behind the drawer
> store chip. Frontend-only, presentation-layer, gated on `useIsPhone()` (Login)
> or scoped to the `ResponsiveCmdShell` phone branch (Notifications / Store
> switch); no backend / migration / edge-function / `src/lib/db.ts` contract
> change.

## Scope (design handoff README §19–21)

### Login (§19)
`LoginScreen` (the shared pre-auth portal) gets an `if (isPhone) return
<PhoneLogin model={…}/>` placed AFTER all hooks (desktop + tablet card layout
byte-unchanged, AC-REG). `PhoneLogin` renders: a centered `im.cmd▮` brand mark
(mono 700 28 + an **accent** block cursor `▮`) + a "RESTAURANT COMMAND CONSOLE"
caption; 48px USERNAME OR EMAIL + PASSWORD wells; a 50px accent SIGN IN →
primary; a FORGOT PASSWORD affordance that surfaces an **honest toast** (no
reset flow exists — only a Register route does); the existing "Have an
invitation? Register" link; the dev-only quick-login accounts (restyled, kept
for the offline dev workflow); and a `2AM PROJECT · <version>` store/version
footer. Auth logic is untouched — every piece of state + the `handleLogin` /
register / quick-login handlers are LIFTED into a `model` bundle (the
spec-145/146 pattern), so `PhoneLogin` forks none of the `signIn` / role-branch
orchestration.

### Notifications (§20)
The phone bar bell (◔) now opens a `ResponsiveSheet` (phone `bottom-sheet`)
instead of toggling push. `PhoneNotifications` renders: a header with MARK ALL
READ + ✕; feed rows with an unread dot (danger = `missed_eod`, accent = every
other submission type — reusing NotificationBell's pure `rowDotColor`), a
two-line title + actor · relative-time meta; a footer PUSH NOTIFICATIONS toggle
(44×26 pill, 20px knob, accent track when on — reusing the shared
`useNotificationToggle` enable/disable model verbatim). Tapping a row marks it
read AND deep-links to the owning section via `usePaletteAction`. The bar
**badge** follows the **spec-121 rule verbatim**: the count chip is danger red
ONLY while an unread `missed_eod` exists, else the neutral accent — reusing
NotificationBell's exported `feedHasUnreadMissed` / `badgeBackgroundColor` /
`badgeTextColor` so the two bells never diverge.

### Store & brand switch (§21)
The phone **drawer header** gains a store chip (`MobileNavDrawer` new optional
`storeChip` slot; dock mode is a deferred spec, so drawer mode is the chip's
home per the handoff). Tapping it opens a `ResponsiveSheet` with: store rows the
caller has access to (✓ CURRENT / SWITCH →, access filtering mirrored verbatim
from `TitleBar`'s store switcher — admin/master/super-admin see all, regular
users see their `user_stores` grants, then narrow to the active brand); a
BRAND · SUPER-ADMIN section (gated on `useIsSuperAdmin`, reusing the `brandsList`
data the desktop `BrandPicker` reads). Picking a different store calls the
EXISTING `setCurrentStore` (which escalates `switching` → the production
spec-111 full-screen takeover painted by the shell) + a toast; picking a brand
calls `setCurrentBrandId` (→ the 'brand' takeover). Both close the sheet AND the
drawer (via `onSwitched`) so the shell-root takeover — which sits BEHIND the
drawer Modal — is visible.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()` / `sans()`;
`ResponsiveSheet` (phone `bottom-sheet`); `MobileTopAppBar` / `MobileNavDrawer`
(spec 142 chrome, new `storeChip` slot); `feedHasUnreadMissed` /
`badgeBackgroundColor` / `badgeTextColor` / `rowDotColor` (NotificationBell,
already exported for spec 121); `useNotificationToggle` (push enable/disable);
`usePaletteAction` (section deep-link bridge); `setCurrentStore` /
`setCurrentBrandId` (spec-111 takeover triggers); `useIsSuperAdmin`; `Toast`;
`APP_VERSION`. No new store fields, no direct `db.ts` access, no new palette
values, no new fonts.

## Acceptance

- Login: `im.cmd▮` mark (accent cursor), 48px wells, 50px accent SIGN IN, honest
  FORGOT PASSWORD toast, store/version footer; every tappable ≥44×44; both themes
  via tokens only.
- Notifications: bell opens the sheet; rows deep-link + mark read; MARK ALL READ
  works; push toggle in the footer; badge red ONLY with an unread `missed_eod`,
  else accent; every tappable ≥44×44.
- Store switch: chip in the drawer header; store rows show CURRENT/SWITCH; a
  switch fires the spec-111 takeover + toast + closes the drawer; brand section
  only for super-admin; access filtering matches the desktop switcher.
- Desktop (≥1100px) + tablet (768–1099px) LoginScreen render output
  byte-unchanged (AC-REG); the phone-branch chrome swaps (bell → PhoneNotifications,
  drawer storeChip) touch only the `isPhone` branch of `ResponsiveCmdShell` and an
  additive optional `MobileNavDrawer` prop — desktop/tablet chrome untouched.
- `npx tsc --noEmit` clean; full `npx jest` green (1658 tests).

## Deviations / notes

- **Login is the SHARED pre-auth portal (spec 063) — the restyle necessarily
  applies to staff too on phone.** `LoginScreen` branches on `profiles.role`
  only AFTER `signIn` resolves; before authentication the role is unknown, so a
  role gate is impossible. The phone restyle is therefore gated on `isPhone`
  alone. This does not introduce a NEW cross-surface leak — the shared portal
  already showed admin-flavored branding ("Inventory Management for Restaurant")
  to both surfaces; this spec swaps that for the `im.cmd▮` console mark. Flagged
  per the task's "if shared, gate so staff login is unaffected, or flag as
  deviation" — gating is not possible, so it is flagged.
- **Notification deep-link is section-level, not vendor-tab depth.** The handoff
  wants "missed → that vendor's EOD count tab". The `usePaletteAction` bridge
  carries `section` + `selectedName` + `eodFocusItemId` (item-scoped), not a
  vendor-tab selector, and extending it to select an EOD vendor tab would require
  changing the EOD section's consumer — out of this frontend-only shell spec.
  `PhoneNotifications` deep-links to the owning **section** (EOD count / weekly
  count / Waste log / Ordering) via the exact existing bridge; the pure
  `sectionForNotification` map is unit-tested. `issue` (a staff report) has no
  admin section → mark-read only (no navigation).
- **The phone bar bell replaced the push toggle; the push toggle relocated into
  the sheet footer.** Pre-148 the phone bar `◔` was `NotificationToggle
  variant="bar"` (a push enable/disable switch). §20 makes the bell open the
  notifications FEED, so the bell is now `PhoneNotifications` and the per-device
  push toggle moves into that sheet's footer. `NotificationBlockedBanner`
  (below-bar blocked copy) is unchanged and independent, so the blocked-state
  messaging path is intact. `NotificationToggle` is still imported by
  `ResponsiveCmdShell` for the tablet rail (full variant) — that caller is
  byte-unchanged.
- **Brand switch reuses BrandPicker's DATA, not the BrandPicker component.**
  `BrandPicker` is a self-contained chip + full-screen-Modal trigger; §21 needs
  inline brand ROWS inside the store sheet, so `PhoneStoreSwitch` reads the same
  `brandsList` / `currentBrandId` / `setCurrentBrandId` / `loadBrandsList` slice
  the picker reads (same defensive re-fetch-on-open idiom) and renders the rows
  itself. No forked brand-switch logic — `setCurrentBrandId` (the spec-111
  'brand' takeover trigger) is the single source.
- **Dev quick-login kept on phone.** The `__DEV__` demo accounts are real
  offline-dev functionality (not a fake form), so they are restyled and preserved
  behind the same `__DEV__` gate; production builds pass an empty `demoUsers`.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneLogin.test.tsx` — brand mark + caption + 48px wells;
  SIGN IN → lifted `onSubmit`; honest FORGOT PASSWORD toast; register link;
  surfaced error; the LoginScreen fork pin (phone → PhoneLogin, desktop + tablet
  → the byte-unchanged card, no phone component).
- `phone/__tests__/PhoneNotifications.test.tsx` — pure `sectionForNotification`
  map (incl. `issue` → null); the badge-color rule (danger ONLY with an unread
  `missed_eod`, accent when submission-only, accent once the miss is read); the
  feed sheet (open → rows; tap → mark-read + section deep-link; MARK ALL READ;
  empty state; issue row = mark-read only, no deep-link).
- `phone/__tests__/PhoneStoreSwitch.test.tsx` — store rows with CURRENT/SWITCH;
  pick → `setCurrentStore` + toast + `onSwitched`; current-store no-op still
  closes the drawer; regular-user access filtering; the super-admin brand gate
  (hidden for admin, shown for super_admin, pick → `setCurrentBrandId`).

## Verification

The `preview_*` browser tooling referenced in the frontend-developer workflow is
not present in this environment (documented for specs 145/146/147), so
verification is via `npx tsc --noEmit` (clean) + full `npx jest` (1658 green).
The PhoneLogin fork-pin suite mounts the REAL `LoginScreen` through the REAL
`isPhone` guard at all three tiers, exercising the `PhoneLogin ↔ LoginScreen`
import graph end-to-end; the notification badge-rule + store-switch suites mount
the real components against the real store slices.

## Files changed

> Also shipped in the same commit (pre-batch chrome fix, claimed here for
> traceability): `src/screens/cmd/sections/eod/PhoneEodCount.tsx` — Hard-Rule-4
> removal of the desktop file-tab strip (count.tsx / history.tsx / variance.log)
> on phone; regression-pinned in `eod/__tests__/EODCountSection.acReg.test.tsx`.

### New
- src/screens/cmd/sections/phone/PhoneLogin.tsx
- src/screens/cmd/sections/phone/PhoneNotifications.tsx
- src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneLogin.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx
- specs/148-phone-shell-trio.md

### Modified — host / chrome (guard + additive slots; desktop/tablet byte-unchanged)
- src/screens/LoginScreen.tsx  (isPhone guard → PhoneLogin; model bundle lifting
  the auth state + handlers)
- src/screens/cmd/ResponsiveCmdShell.tsx  (phone branch: bar bell →
  PhoneNotifications; drawer `storeChip` → PhoneStoreSwitch)
- src/components/cmd/MobileNavDrawer.tsx  (additive optional `storeChip` header slot)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (chrome.phone.login.*,
  chrome.phone.notifications.*, chrome.phone.storeSwitch.*)

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/148-phone-shell-trio/reviews/<your-name>.md.
payload_paths:
  - specs/148-phone-shell-trio.md
  - src/screens/cmd/sections/phone/PhoneLogin.tsx
  - src/screens/cmd/sections/phone/PhoneNotifications.tsx
  - src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx
  - src/screens/LoginScreen.tsx
  - src/screens/cmd/ResponsiveCmdShell.tsx
  - src/components/cmd/MobileNavDrawer.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneLogin.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
