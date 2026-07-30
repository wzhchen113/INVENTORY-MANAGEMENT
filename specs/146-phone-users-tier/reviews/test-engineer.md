## Test report for spec 146

Track confirmation: frontend-only per the spec header. `git show --stat
1661d54` shows zero touched files under `supabase/`, `scripts/`, or `e2e/` for
the whole batch. **Jest track only**, no fourth framework introduced.

### Acceptance criteria status

- AC1 (full names + emails, no sideways/stacked text, no horizontal scroll,
  every tappable ≥44×44, both themes via tokens, role pills use info/ok/
  neutral — never accent) → PARTIAL/PASS split — the never-the-accent claim
  IS directly jest-asserted for the role pill (see Notes). Layout/dimension/
  no-horizontal-scroll claims are structural, not jest-measured. **This is the
  one screen in the whole batch the dispatcher could NOT browser-verify** —
  per the task brief, `PhoneUsers` has no drawer nav entry in this environment
  (pre-existing config gap, not introduced by this spec), so there is no live
  375×812 visual pass for this screen, unlike every other phone surface in
  specs 143/144/145/147/148. This narrows the evidence for the untested half
  of AC1 to jest + static source review only — weaker than the other five
  specs' mitigating evidence. I looked at `PhoneUsers.tsx` directly: the row/
  detail/pill dimensions are hardcoded style constants (48/44/56px etc.,
  matching the spec's stated targets) and colors route through
  `useCmdColors()` tokens, consistent with the pattern used elsewhere in this
  batch — no red flags on inspection, but this is source-review confidence,
  not test or manual-verification confidence. Flagging as a genuine
  (non-blocking, but real) coverage gap specific to this spec.
- AC2 (desktop/tablet render output byte-unchanged, AC-REG) → PASS —
  `phone/__tests__/PhoneUsers.acReg.test.tsx` (desktop + tablet render the
  desktop `users.tsx` TabStrip tree via the real `UsersSection`; phone renders
  `PhoneUsers` and drops the tab strip). Diff review of `UsersSection.tsx`
  confirms the claimed edit surface (guard + `PhoneUsers` import + a model
  bundle lifting the user list/handlers/overlay state) — desktop return
  subtree, including its own `InviteUserDrawer`/`TypeToConfirmModal`
  instances, is untouched. The spec's claim that PhoneUsers mounts its OWN
  copies of those overlays bound to the same host state (so they never
  double-mount) is consistent with what `PhoneUsers.test.tsx` exercises (see
  below) — no test explicitly asserts non-double-mounting across both trees
  simultaneously (the acReg test never renders both trees at once, by design,
  since only one is ever mounted per tier), but that's the correct behavior
  to assert given the fork is a single early-return, not a conditional overlay
  toggle.
- AC3 (`npx tsc --noEmit` clean; full `npx jest` green — spec claims 1605,
  final batch total 1658) → **PARTIAL.** `npx tsc --noEmit` is clean. Full
  `npx jest`: 172 suites / 1658 tests, all green. However `npm run
  typecheck:test` **FAILS**, and one of the three repo-wide errors is inside
  this spec's own new file:
  `src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx(37,54): error
  TS2556: A spread argument must either have a tuple type or be passed to a
  rest parameter.` — the mock `inviteUser: (...args: unknown[]) =>
  mockInviteUser(...args)` spreads an `unknown[]` into `mockInviteUser`,
  which is declared as a zero-arg `jest.fn(() => Promise.resolve({ error:
  null }))` — TS can't verify the spread matches a zero-arg signature. Same
  class of bug as specs 143/144's occurrences — see the consolidated
  recommendation in spec 148's report.

### Test run

```
npx tsc --noEmit                        → clean, 0 errors
npm run typecheck:test                  → FAILS, 3 errors repo-wide; this
                                           spec's PhoneUsers.test.tsx is one of
                                           them (line 37, TS2556)
npx jest                                 → Test Suites: 172 passed, 172 total
                                           Tests: 1658 passed, 1658 total
                                           Snapshots: 2 passed, 2 total
```

pgTAP / shell smokes not run — no DB/edge/RPC surface in this spec (the
`inviteUser` edge-function call itself is mocked in the jest test, per the
project's documented `src/lib/auth.ts` carve-out and the fact this spec makes
no contract change to it).

### Notes

- **Never-the-accent role pill** — PASS, directly asserted and structurally
  pinned: `PhoneUsers.test.tsx::maps each stored role to a semantic tone
  (never accent)` asserts `rolePillTone('admin')` → `'info'`,
  `rolePillTone('super_admin')` → `'info'`, `rolePillTone('master')` →
  `'ok'`, `rolePillTone('user')` → `'neutral'`, and additionally loops all
  three resolved tones asserting none equals `'accent'`. A second test renders
  the admin pill and asserts the actual rendered `color` style is NOT
  `LightCmd.accent` — this is the double-layer (pure-helper + rendered-output)
  test discipline the "never accent" rule deserves.
- **INVITED pending pill + row rendering** — PASS —
  `::shows an INVITED pill for a pending user` and `::renders a row with the
  role pill + email meta` both assert against real fixture data, not
  snapshots.
- **Drill-in detail + reused `TypeToConfirmModal` for DELETE** — PASS —
  `::opens the full-screen detail and DELETE arms the type-to-confirm modal`
  confirms the reused modal is what's armed (not a forked confirm dialog).
- **Reused `InviteUserDrawer` send path** — PASS — `::open → fill email +
  name → SEND calls inviteUser and onInvited` asserts the mocked `inviteUser`
  is actually invoked and `onInvited` fires (the host's `refresh()` trigger),
  not just that the drawer opens.
- **`useIsMaster` role-chip gating** — PASS —
  `::gates the role chips: master sees them, a plain admin does not` asserts
  both branches of the gate, not just the permissive one.
- **No pre-existing `UsersSection*.test.tsx` suite** — confirmed by `grep`;
  correctly, no desktop-forcing mock was needed elsewhere for this spec.
- **i18n parity** — verified programmatically across all three catalogs (0
  missing/extra keys), including this spec's large `section.users.phone.*` key
  set (parentCaption/count/storesTag/invited/invite/properties/prop*/
  deleteTitle/deleteSelfTitle/etc).
- **Verification section is honest about the gap** — the spec's own
  "Verification" section states browser preview tooling was unavailable and
  relies on `npx tsc --noEmit` + jest; it does not separately surface the
  no-drawer-nav-entry limitation for manual verification specifically (that
  detail came from the dispatcher's task framing to me, not from the spec
  text itself) — worth carrying forward explicitly the next time PhoneUsers
  visual/dimension claims need re-verifying, since jest is the only net under
  it today.

### Verdict for this spec

No FAIL on this spec's own core acceptance criteria — the never-the-accent
role-pill guarantee, the row/detail/delete/invite behaviors, and the AC-REG
pin are all directly and precisely tested. Two things keep this from a clean
PASS-across-the-board:
1. The `typecheck:test` CI gate is broken, with this spec's own
   `PhoneUsers.test.tsx` contributing one of the three errors (see spec 148
   for the consolidated fix recommendation).
2. This is the one screen with no manual/visual verification at all (no
   browser pass was possible), so the layout/dimension/no-horizontal-scroll
   half of AC1 rests on jest (partial, and only for the pieces jest actually
   measures) plus static source review — genuinely weaker evidence than the
   other five specs in this batch, though not zero evidence. I'm not scoring
   this NOT TESTED outright given the jest coverage of the pill/role logic and
   the source-level consistency with the rest of the batch's pattern, but it
   is the weakest-covered AC in the six-spec set and should be prioritized if/
   when the drawer nav gap is fixed and a manual pass becomes possible.

## Handoff
next_agent: NONE
prompt: Test report complete for spec 146.
payload_paths:
  - specs/146-phone-users-tier/reviews/test-engineer.md
