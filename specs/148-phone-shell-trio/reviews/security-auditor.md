# Security audit for spec 148 — Phone shell trio (Login / Notifications / Store switch)

Scope verified against `git show 1661d54 --stat`: frontend-only. New
`PhoneLogin.tsx` / `PhoneNotifications.tsx` / `PhoneStoreSwitch.tsx` + tests;
hosts `LoginScreen.tsx` (isPhone guard + model lift), `ResponsiveCmdShell.tsx`
(phone-branch bell + drawer storeChip), `MobileNavDrawer.tsx` (additive optional
`storeChip` slot); i18n additions. No migration, edge function, RLS, or
`src/lib/db.ts` contract change — matches the spec's frontend-only claim.

This is the pre-auth surface, so I audited the login path specifically.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- None.

### Notes (not findings)
- **Login auth logic is lifted, not forked.** `LoginScreen.tsx:132-166` passes
  every piece of auth state + the `handleLogin` / register / `quickLogin`
  handlers into `PhoneLogin` via a `model` bundle. `PhoneLogin.tsx` contains no
  `signIn` / role-branch orchestration — it is presentation only.
- **No credential logging or persistence.** Password field uses `secureTextEntry`
  (`PhoneLogin.tsx:143`); no `console.*`, no storage write, no credential in any
  toast or navigation payload. The FORGOT PASSWORD affordance is an honest toast
  (`PhoneLogin.tsx:57-58`) — no fake reset flow.
- **Dev quick-login is `__DEV__`-gated.** `LoginScreen.tsx:133` builds `demoUsers`
  only when `__DEV__`; production builds pass `[]`, so the quick-login block never
  renders (`PhoneLogin.tsx:208`). Seed emails/names come from `../data/seed` (dev
  fixtures), not prod data.
- **Shared-portal restyle applies to staff too** — correctly flagged as a
  deviation in the spec (role is unknown pre-auth, so a role gate is impossible).
  This does not introduce a new cross-surface leak: the pre-auth portal already
  rendered shared branding to both surfaces; only the visual mark changed. Not a
  finding.
- **Notifications: no content leak.** `PhoneNotifications` reads the
  `submissionNotifications` slice (already RLS-fetched) and reuses NotificationBell's
  exported pure helpers (`feedHasUnreadMissed` / `badgeBackgroundColor` /
  `badgeTextColor` / `rowDotColor`) — the spec-121 badge rule stays byte-identical.
  Deep-link via `usePaletteAction` carries `{ section, selectedName: null }` only —
  no notification body in the navigation payload, no logging. `issue` rows are
  mark-read-only (null section). Mark-read reuses store actions.
- **Store switch: access filtering mirrors the desktop TitleBar switcher.**
  `PhoneStoreSwitch.tsx:56-66` — admin/master/super-admin see all stores, regular
  users see only their `user_stores` grants, then narrowed to the active brand.
  The client `stores` list is already RLS-filtered server-side; this is a UI
  narrowing, not the security boundary. The BRAND section is gated on
  `useIsSuperAdmin` (`:193`) and `loadBrandsList` / `setCurrentBrandId` are
  RLS-gated to super-admin server-side (the client gate is cosmetic, with a server
  backstop). `setCurrentStore` / `setCurrentBrandId` are the existing spec-111
  takeover triggers — no forked switch logic.
- `MobileNavDrawer` / `ResponsiveCmdShell` changes are additive (optional
  `storeChip` prop; bell swap confined to the `isPhone` branch) — desktop/tablet
  chrome untouched. No secrets in i18n additions (UI labels only).

### Dependencies
No `package.json` changes — `npm audit` skipped.
