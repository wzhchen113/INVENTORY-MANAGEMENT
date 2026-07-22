# Code review for spec 136

Scope: `src/lib/useNotificationToggle.ts`, `src/lib/useNotificationToggle.test.tsx`
(new), `src/screens/staff/components/NotificationReminderBanner.tsx` (comment
fix), `jest.config.js` (testMatch addition). Cross-checked against the spec's
`## Backend design` (module-scoped registry shape, broadcast trigger points,
acting-vs-other split, jest approach) and CLAUDE.md conventions.

### Critical

None.

### Should-fix

- `jest.config.js:87-94` and `jest.config.js:120-124` — the `src/lib/**/*.test.tsx`
  glob was added to BOTH the `unit` (node) and `component` (jsdom) project
  `testMatch` arrays to accommodate the architect-specified filename
  `useNotificationToggle.test.tsx`. But the file contains zero JSX (`src/lib/useNotificationToggle.test.tsx:58-167`
  — only `renderHook`/`act`/`waitFor` calls, no `<Component />` markup), so it
  would have run correctly as `.test.ts` and matched the pre-existing
  `<rootDir>/src/lib/**/*.test.ts` glob (`jest.config.js:86`) with **no**
  `jest.config.js` edit at all. The chosen fix instead (a) modifies shared test
  infrastructure for a spec that "touches ZERO backend" and is scoped to one
  hook file, and (b) makes the suite run twice — the test file's own header
  comment (`src/lib/useNotificationToggle.test.tsx:18-23`) admits the two
  environments are "structurally inert" duplicates of each other (identical
  assertions, no environment-dependent branch), so the second run adds CI time
  with zero incremental signal. It also silently widens the `component` project
  to pick up any future `src/lib/**/*.test.tsx` file, which may not always be
  intended to double-run. Prefer renaming the test file to
  `useNotificationToggle.test.ts` and reverting the `jest.config.js` hunks
  entirely — this is a smaller, lower-risk diff that stays inside the
  established two-glob pattern from `tests/README.md` rather than adding a
  third. If the architect's `.tsx` filename is load-bearing for some reason not
  stated in the design, that should be spelled out in the spec; as written this
  reads like an avoidable test-infra touch. (Coordinate final call with
  test-engineer since this borders on test-track conformance.)

### Nits

- `src/lib/useNotificationToggle.ts:26-51` — the registry section's comments are
  thorough and rationale-bearing (good), but the same "acting instance
  excluded / others get refresh(true)" explanation is repeated near-verbatim
  three times (module header, `broadcastReprobe` doc, and again at the
  `reprobe` definition and inside `enable`/`disable`). Not wrong, just
  redundant enough that a future edit to the invariant would need to be kept in
  sync in four places. Low priority given the codebase's existing
  heavily-commented style.
- `src/lib/useNotificationToggle.test.tsx:94-95,118-119,147-148` — three tests
  each hand-roll `const A = renderHook(...); const B = renderHook(...);`
  identically. A tiny local helper (`function mountPair(probe) {...}`) would
  remove the duplication, but this is squarely in-file, non-architectural, and
  low value for a 3-test file — not worth blocking on.

## Verification detail

- **Registration ordering matches the pinned design.** `reprobeListeners.add(reprobe)`
  (`src/lib/useNotificationToggle.ts:116`) sits before the
  `Platform.OS === 'web'` guard (`src/lib/useNotificationToggle.ts:120`), and
  the cleanup unconditionally calls `reprobeListeners.delete(reprobe)`
  (`src/lib/useNotificationToggle.ts:129`) ahead of the optional
  `removeVis?.()`. This matches the spec's load-bearing ordering constraint and
  is what lets the node-env jest project exercise the registry at all.
- **`broadcastReprobe(except)` identity-exclusion is correct.** `except` is the
  same `reprobe` reference registered in the `Set`
  (`src/lib/useNotificationToggle.ts:106-108, 116`), so
  `if (listener !== except) listener()` (`src/lib/useNotificationToggle.ts:47-51`)
  skips exactly the acting instance by reference equality — no id/token
  comparison bugs possible.
- **Acting instance's message-preserving `refresh(false)` is intact.** Both
  `enable` (`src/lib/useNotificationToggle.ts:134-145`) and `disable`
  (`src/lib/useNotificationToggle.ts:147-154`) call `await refresh(false)` for
  themselves (spec-118 guard: `clearMessage=false` skips `setMessage(null)`,
  `src/lib/useNotificationToggle.ts:96-100`) and only then
  `broadcastReprobe(reprobe)`, which fans out `refresh(true)` (message-clearing)
  to every OTHER registered listener. Traced through the new
  `useNotificationToggle.test.tsx` "preserves the acting instance transient
  failure message" case (lines 137-167): A's `body` stays
  `chrome.notifications.msg.denied` while B's `body` is `null` — confirms the
  split fires in the intended direction.
- **Dependency arrays.** `reprobe` is `useCallback(..., [refresh])` and `refresh`
  is `useCallback(..., [])`, so both are referentially stable across renders;
  `reprobe` was correctly added to the mount effect's deps
  (`src/lib/useNotificationToggle.ts:132`) and to `enable`/`disable`'s deps
  (`src/lib/useNotificationToggle.ts:145,154`) without introducing re-subscribe
  churn or a stale closure. No missing or spurious deps found.
- **No `@react-navigation` import in the shared hook.** `src/lib/useNotificationToggle.ts:1-24`
  imports only `react`, `react-native`, `./notificationState`, `./webPush` — the
  out-of-scope navigation-coupling constraint from the spec is respected. (The
  pre-existing `useNavigation` import in `NotificationReminderBanner.tsx:26` is
  unchanged and was already there before this spec; not a regression.)
- **No `supabase.from/rpc` introduced.** Confirmed by inspection of all four
  changed files; the hook derives state purely from browser probes plus
  `webPush.ts`, which is a documented `db.ts` carve-out per CLAUDE.md.
- **Comment fix reads correctly and is scoped as advertised.**
  `NotificationReminderBanner.tsx:11-22` replaces the false "single live probe"
  claim with an accurate description of the four screens staying mounted and
  the spec-136 broadcast as the sync mechanism; no behavior change alongside it
  (verified — only the header comment block differs from prior behavior; the
  component body at lines 42-66 is otherwise untouched).
