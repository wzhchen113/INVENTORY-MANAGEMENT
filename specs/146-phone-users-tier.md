# Spec 146: Phone tier for the Users & access screen (+ INVITE sheet)

Status: READY_FOR_REVIEW

> Next increment of the admin-console phone-optimization program (specs
> 140/142/143/144/145) driven by the external design handoff
> (`design_handoff_imr_phone`, README §7–17 "Users & access" + the shared
> list-shell pattern). Spec 142 delivered the global chrome + the shared
> list/detail drill-in scaffold + `PhoneWidgets`; specs 143/144/145 the Ordering,
> Weekly-count, and Dashboard tiers. This spec covers the **Users & access**
> screen: the desktop `UsersSection` (a `TabStrip` + a single-column ScrollView of
> wrapping multi-column rows with inline RESET PW / DELETE toolbars) becomes a
> full-width two-line card list → full-screen drill-in detail, plus a 48px
> "+ INVITE" primary that opens the reused production `InviteUserDrawer`.
> Frontend-only, presentation-layer, gated on `useIsPhone()`; no backend /
> migration / edge-function / `src/lib/db.ts` contract change.

## Scope (design handoff README §7–17)

Behind `if (isPhone) return <PhoneUsers model={…}/>` placed AFTER all hooks in
`UsersSection.tsx` (desktop + tablet byte-unchanged, AC-REG):

- **Header:** the localized `section.users.title` ("Users & access") + a mono
  "{n} USERS" count caption.
- **User rows (`FlatList`, `TwoLineRow`):** role pill (semantic tokens — ADMIN /
  SUPER-ADMIN = `info`, MASTER = `ok`, STORE USER = `neutral`; NEVER the accent)
  + name (flex:1, ellipsized) + a right "{n} STORES" value; line 2 = email meta +
  an `INVITED` `StatusPill` for `status === 'pending'` rows. Store counts derive
  from the shared `deriveAccessibleStores` helper (spec 068), so the brand-scoped
  visibility matches the desktop chips.
- **Detail (`PhoneDrillScaffold` + `usePhoneDrill`):** role pill + email caption +
  name title; a `PropertyCard` (ROLE / STORES / STATUS + USERNAME when present);
  and the desktop-reusable actions only — RESET PW (gated by the same predicate as
  the desktop `UserRow`) and DELETE (gated by `canDeleteUser`, same last-of-role /
  self-guard). DELETE arms the reused `TypeToConfirmModal` (type-the-email
  confirm) which calls the host's `handleConfirmDelete` (self-delete → logout,
  else refresh) verbatim.
- **+ INVITE sheet:** a 48px accent primary opens the production
  `InviteUserDrawer` (reused, not forked) — the real validated form (email + name
  + optional username + role chips gated by `useIsMaster` + brand-scoped stores),
  submitting through the existing `inviteUser` edge-function path. On success the
  drawer calls the host's `onInvited` → `refresh()`, so the new pending user
  re-fetches and lands in the list as an `INVITED` row.
- Everything full-width; no `TabStrip`, no inline toolbars (Hard Rule 4); every
  tappable ≥44×44 (rows ≥56, actions 48, INVITE 48); both themes via tokens only.

## Reuse (no new primitives, no forked logic)

`useCmdColors()` / `CmdRadius` / `PhoneType` / `mono()`; `TwoLineRow` +
`PropertyCard` (`PhoneWidgets`); `PhoneDrillScaffold` + `usePhoneDrill` (spec
142); `StatusPill`; `InviteUserDrawer` + `TypeToConfirmModal` (reused verbatim);
`roleLabel` / `userStatusLabel` (`enumLabels`); `canDeleteUser` /
`deriveAccessibleStores` (`userPermissions`). The user list, `lastOfRole`, the
invite/delete overlay STATE, and the `handleConfirmDelete` / `handleSendReset` /
`refresh` handlers all stay in `UsersSection` and are passed down in a `model`
bundle — the spec-145 PhoneDashboard lift pattern (no new store fields, no direct
`fetchAllUsers` fork, single fetch owned by the host).

## Acceptance

- Full names + emails (flex:1, ellipsize only past full width); no
  sideways/stacked text; no horizontal scroll; every tappable ≥44×44; both themes
  via tokens only; role pills use `info` / `ok` / neutral (`fg2`/`panel2`), never
  the accent.
- Desktop (≥1100px) + tablet (768–1099px) render output byte-unchanged (AC-REG):
  the guard + a `useIsPhone()` read + the `PhoneUsers` import + the model bundle
  are the only edits to `UsersSection.tsx`; the desktop return subtree (including
  its `InviteUserDrawer` + `TypeToConfirmModal` overlays) is untouched. The phone
  early-return mounts PhoneUsers' own copies of those overlays bound to the SAME
  host state, so they never double-mount.
- `npx tsc --noEmit` clean; full `npx jest` green (1605 tests).

## Deviations / notes

- **Reused the full `InviteUserDrawer`, not a reduced email+role bottom-sheet.**
  The prototype's INVITE frame shows a minimal email + role-chips sheet, but the
  real `inviteUser` requires a display name (and an admin invite requires a
  brand). A reduced sheet would either fail validation or FORK the validation the
  task forbids, so PhoneUsers opens the production drawer (which already renders
  through `ResponsiveSheet` — fullscreen on phone). This is the sanctioned
  "present the existing drawer's core in a ResponsiveSheet" option. Role-chip
  visibility still respects the `useIsMaster` gate.
- **Role-pill scheme mapped onto the four real roles.** The handoff's ADMIN=info /
  MANAGER=ok / STAFF=neutral is generic; this codebase has `admin` / `super_admin`
  / `master` / `user`. Mapping: admin + super_admin → `info` (admin tier), master
  → `ok` (manager-equivalent), user → neutral. Exposed as the pure `rolePillTone`
  helper so the never-the-accent guarantee is unit-testable.
- **PropertyCard shows STATUS, not "joined".** The handoff detail lists "joined",
  but the `User` type carries no created/joined timestamp — surfacing a fabricated
  date would be dishonest, so the card shows ROLE / STORES / STATUS (+ USERNAME
  when present) instead.
- **Delete + reset reuse the desktop flow; no honest-toast stub.** Both
  `TypeToConfirmModal` + `deleteProfile` and `sendPasswordReset` are
  cross-platform-safe, so they are reused directly (the handoff's honest-toast
  rule only applies to desktop-only edit forms — of which Users has none). The
  detail therefore has no edit affordance, matching the desktop (which also has
  no role-edit form).
- **Model-lift, single fetch.** The host still owns `fetchAllUsers` + `refresh`;
  PhoneUsers receives derived data + handlers, forking no orchestration.

## Tests (jest track only — no DB/edge change)

- `phone/__tests__/PhoneUsers.test.tsx` — `rolePillTone` semantic mapping incl.
  the never-the-accent assertion (admin pill renders in the `info` token, distinct
  from the accent); rows with role pill + email + the `INVITED` pill for pending;
  the drill-in detail + DELETE arming the reused `TypeToConfirmModal`; the reused
  `InviteUserDrawer` send path (fill email + name → SEND calls `inviteUser` +
  `onInvited`); the `useIsMaster` role-chip gating (master sees the chips, a plain
  admin does not).
- `phone/__tests__/PhoneUsers.acReg.test.tsx` — desktop + tablet render the
  desktop `users.tsx` TabStrip tree, not the phone component; phone renders it and
  drops the tab strip. Mirrors `PhoneOrdering.acReg.test.tsx`.
- No existing `UsersSection*.test.tsx` suite exists, so no desktop-forcing
  `theme/breakpoints` mock was needed elsewhere.

## Verification

Browser preview tooling was not available in this environment, so verification is
via `npx tsc --noEmit` (clean) + full `npx jest` (1605 green). The jest component
project renders PhoneUsers through the REAL `UsersSection` guard and the REAL
`InviteUserDrawer` send path, so the `PhoneUsers ↔ UsersSection ↔ InviteUserDrawer`
import graph is exercised end-to-end.

## Files changed

### New
- src/screens/cmd/sections/phone/PhoneUsers.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx
- specs/146-phone-users-tier.md

### Modified — host section (guard + model lift; desktop/tablet byte-unchanged)
- src/screens/cmd/sections/UsersSection.tsx  (isPhone guard → PhoneUsers; model
  bundle lifting the user list + handlers + overlay state)

### Modified — i18n (all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json  (section.users.phone.* — parentCaption,
  count, storesTag, invited, invite, loading, empty, noStores, noEmail, you,
  properties, propRole, propStores, propStatus, propUsername, resetPw, deleteUser,
  deleteTitle, deleteSelfTitle, deleteBody, deleteSelfBody, thisUser)

## Handoff

next_agent: code-reviewer, security-auditor, test-engineer
prompt: Review the implementation of this spec. Each reviewer writes its findings
  to specs/146-phone-users-tier/reviews/<your-name>.md.
payload_paths:
  - specs/146-phone-users-tier.md
  - src/screens/cmd/sections/phone/PhoneUsers.tsx
  - src/screens/cmd/sections/UsersSection.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx
  - src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx
  - src/i18n/en.json
  - src/i18n/es.json
  - src/i18n/zh-CN.json
