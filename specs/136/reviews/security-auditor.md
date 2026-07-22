# Security audit for spec 136

Scope: frontend-only cross-instance sync for the Web Push toggle hook. Files
reviewed: `src/lib/useNotificationToggle.ts`, `src/lib/useNotificationToggle.test.tsx`,
`src/screens/staff/components/NotificationReminderBanner.tsx`, `jest.config.js`,
plus the spec itself. Threat-model checks: DB call-site carve-outs, secret
handling, data exposure via the broadcast, listener leak/unbounded growth, and
jest glob over-capture.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- None.

## Verification detail

- **No new DB call sites.** Grep of the four changed files for
  `supabase` / `.from(` / `.rpc(` returns nothing. The hook performs zero
  PostgREST/RPC traffic (it derives per-device state from browser APIs via the
  mocked-at-test `probeNotificationState`), so the "all DB access flows through
  `db.ts`" rule does not engage and no carve-out is added or violated.
  `src/lib/useNotificationToggle.ts:1-207`.

- **No secret/credential handling.** No `Deno.env`, `process.env`,
  `EXPO_PUBLIC_*`, tokens, or keys in any changed file. Nothing logged. The
  broadcast path (`broadcastReprobe`) touches no auth material.
  `src/lib/useNotificationToggle.ts:47-51`.

- **No data exposure through the broadcast.** The registry entries are zero-arg
  triggers — `type ReprobeListener = () => void`
  (`src/lib/useNotificationToggle.ts:37`). `broadcastReprobe` invokes each
  listener with NO arguments (`src/lib/useNotificationToggle.ts:48-50`); each
  listener is `reprobe = () => void refresh(true)`
  (`src/lib/useNotificationToggle.ts:106-108`), which re-reads local browser
  state and calls `setState` on its own instance. No user id, no subscription
  data, no PII crosses the registry — the broadcast is a pure "go re-probe
  yourself" signal. `userId` is closed over per-instance and never transported
  through the module-scoped `Set`. Cross-tenant/cross-user leakage is not
  possible because nothing is carried.

- **No listener leak / unbounded growth.** Registration is in the mount effect
  (`reprobeListeners.add(reprobe)`, `src/lib/useNotificationToggle.ts:116`) and
  the cleanup ALWAYS deletes (`reprobeListeners.delete(reprobe)`,
  `src/lib/useNotificationToggle.ts:129`) — the delete sits before any
  early-return and is not inside the web-only guard, so native/SSR instances
  unregister too. `reprobe` is `useCallback([refresh])`-stable and `refresh` is
  `useCallback([])`-stable, so the effect runs once per mount and cleans up once
  per unmount — no re-subscription churn. A `Set` keyed on the stable identity
  makes a StrictMode dev double-invoke idempotent (add of an existing member is a
  no-op; delete removes the single entry). Registry size is bounded by the number
  of live toggle instances (≤ ~4 in practice). No growth path.

- **jest glob does not over-capture.** The added `testMatch` entry
  `<rootDir>/src/lib/**/*.test.tsx` (`jest.config.js:94` unit, `jest.config.js:124`
  component) is scoped to `.test.tsx` under `src/lib` only. `find src/lib
  -name '*.test.tsx'` returns exactly one file — the new spec-136 test. No
  production source, fixture, or unrelated suite is pulled in. The unchanged
  `modulePathIgnorePatterns` still excludes `.claude/worktrees/` and
  `extension/`, so no external build artifact is drawn in. The test itself uses
  only mocked collaborators (`./webPush`, partial-mock `./notificationState`) —
  no network, no real push stack, no filesystem writes.

- **Stale-comment fix is comment-only.** `NotificationReminderBanner.tsx:11-22`
  is a documentation change with no behavior change; no auth/authz surface.

## Dependencies

No `package.json` change — `npm audit` skipped. (`jest.config.js` changed, but it
declares no new dependency.)

## Conclusion

Frontend-only, in-process UI sync. No authorization surface, no secrets, no data
exposure, no leak, no dependency delta. Nothing blocks; nothing to fix before
deploy.
