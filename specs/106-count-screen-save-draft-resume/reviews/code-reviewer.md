# Code review for spec 106

Scope: both slices (backend + frontend) of the count-screen save-draft + resume
feature. Reviewed against design §0-§15, AC-1..AC-18, and the `## Files
changed` list. Architecture drift and RLS/security depth are deferred to the
architect and security-auditor respectively; findings below are craft/
convention/correctness issues discoverable from the diff itself.

### Critical

- `src/hooks/useConnectionStatus.ts` (admin top-level hook, used by
  `src/screens/cmd/sections/InventoryCountSection.tsx:46,196`) — **the admin
  Save online/offline branch and the reconnect draft-sync are driven by the
  wrong signal.** `useConnectionStatus()` here reports the Supabase **realtime
  socket's** open/closed state (`socket.onOpen`/`onClose`/`onError`), not
  browser network connectivity. Two concrete consequences:
  1. **False negative on web.** A user can be genuinely online (has internet,
     PostgREST `fetch` calls succeed fine) while the realtime websocket is
     mid-reconnect (tab backgrounded, brief blip, server restart, heartbeat
     timeout — up to ~30s per the hook's own doc comment). During that window
     `isOnline` is `false`, so `onSaveDraft` (lines 557-615) takes the
     **offline** branch and writes an unsynced local-only draft and shows
     "Saved on this device" even though the server write would have succeeded.
  2. **Always-true on native.** The entire subscription is gated behind
     `if (Platform.OS !== 'web') return;` (line 118 of the hook) — on admin
     native, `isOnline` is permanently the `useState` seed value (optimistic
     `true`) and never flips false. A genuinely offline admin-native user never
     takes the offline-Save branch; `saveCountDraft` just throws and falls into
     the "server-error" catch (lines 596-611), producing the wrong toast copy
     (`saveFailed`/`savedLocal` combo) instead of the AC-14 offline copy, and
     the reconnect-sync effect (lines 503-548) never fires on native because
     `isOnline` never transitions false→true.
  - The design text itself asserts "admin web via the same `window 'online'`
    event `useConnectionStatus` already listens to" (§9) — that claim is false
    for the top-level hook; the `window 'online'`/`'offline'` listener pattern
    only exists in the **staff** copy
    (`src/screens/staff/hooks/useConnectionStatus.ts:52-61`), which the FE dev
    was explicitly told NOT to import into admin (CLAUDE.md carve-out
    boundary, correctly respected). The FE dev's flagged choice ("uses the
    ADMIN top-level `useConnectionStatus`... no staff-subtree import" —
    `InventoryCountSection.tsx:42-46`) is the right carve-out call but the
    wrong hook for this job: `useConnectionStatus` was built (spec 059) to
    drive a connection-status indicator dot, not to gate an offline-fallback
    write path. Fix: either add a `navigator.onLine`/`window` online/offline
    listener directly in `InventoryCountSection.tsx` (matching the staff
    pattern, web-only per CLAUDE.md's `Platform.OS === 'web'` rule) or
    introduce a small admin-side network-connectivity hook distinct from the
    realtime-socket indicator. This is the one design-contract semantic
    (AC-13/14/15 "online"/"offline") that landed materially different from
    what §9 describes and what the staff mirror actually does correctly.

### Should-fix

- `src/screens/cmd/sections/InventoryCountSection.tsx` — **AC-6's "jump to the
  first uncounted row" is not implemented on the admin screen.** `firstUncounted`
  (from `src/lib/countOrder.ts`) is never imported or called anywhere in this
  file; there is no scroll/focus/`pendingFocusId`-style machinery at all. The
  staff `WeeklyCount.tsx` implements this fully (`jumpToFirstUncounted` at
  lines 362-378, wired into `restoreDraftToForm` at line 391) — confirming the
  gap is isolated to the admin path, not a spec misreading. AC-6 text is
  unconditional across both named screens ("the screen jumps to the first
  uncounted row via the existing `firstUncounted` helper"). The design's §14
  bullet for admin does soften this to "a scroll/focus affordance, not a
  submit-blocker" (admin Inventory count has no count-everything gate), which
  is why this lands as Should-fix rather than Critical, but the AC as written
  is not met. Fix: call `firstUncounted` against the current render order
  (mirroring the staff `ordered` construction) inside `restoreDraftToForm` and
  scroll/focus the target row, or explicitly amend the AC if the PM/architect
  agrees the admin jump is out of scope for v1.

- `src/screens/cmd/sections/InventoryCountSection.tsx:620-642` and
  `src/screens/staff/screens/WeeklyCount.tsx:576-593` — **`onDiscardDraft`
  clears the local copy and the form unconditionally, but only
  `console.warn`/`notifyBackendError`-logs a failed server `deleteCountDraft`
  call with no revert.** If the server delete fails (network drop at the exact
  moment of Discard), the user sees an empty form and no banner — but the
  server-side draft row still exists. The next screen-open's draft-load effect
  will re-fetch it and silently resurrect the "discarded" draft, which directly
  contradicts what the user just did. AC-7 doesn't spell out revert-on-failure,
  and the codebase has precedent for accepting best-effort/torn-write windows
  on private per-user view state (spec 103's `saveCountOrder` delete-then-insert
  is documented as non-atomic and accepted) — but that precedent is for a
  reorder preference, not a user-initiated "delete my draft" action whose whole
  point is durability of the negative. Consider either retry-with-toast on
  server-delete failure, or a lightweight "your discard may not have synced —
  it will retry" toast so the resurrection isn't a silent surprise.

- `src/lib/countDrafts.ts:249-254,301-304` (doc comments on
  `deserializeAdminInventoryDraft`/`deserializeWeeklyDraft`) — the comments
  claim tolerance of "malformed / **unknown-`v`** / non-object payload," but
  the implementation never inspects the `v` field at all — it only guards on
  `typeof payload !== 'object' || payload === null || Array.isArray(payload)`.
  A payload with `v: 999` and otherwise well-shaped fields deserializes
  normally (which is arguably the right behavior — forward-tolerant field
  reading rather than version-gating), but the comment overstates what the
  code does and could mislead a future reader debugging a real version-bump
  scenario into thinking there's a version check to update. `countDrafts.test.ts:240`
  has the same mismatch — its title says "an unknown-v / partial payload" but
  the fixture at line 242-246 has no `v` key at all and the test actually
  exercises "numeric map value dropped," not version handling. Tighten the
  comments/test title to describe what's actually tested (missing-`v` and
  non-`v`-gated field tolerance), or add an explicit `v` check if
  version-gating was actually intended.

### Nits

- `src/screens/staff/screens/WeeklyCount.test.tsx:561-569` — a second
  `twoItems()` helper is declared inside the new
  `describe('WeeklyCount — spec 106 save-draft + resume', ...)` block,
  shadowing the pre-existing one at line 441. It is never called within the
  new block (only `oneItem()` is used there). Since test files are excluded
  from `tsc` (`tsconfig.json:13-14`) and there's no project ESLint config to
  catch it, this is dead code that will sit unflagged. Delete it.
- `src/lib/countDrafts.ts:79-142` (`reconcileDrafts`) — the "local only" branch
  comment (lines 117-120) hedges with "if it were somehow already synced=false
  only by flag, pushing is still correct and idempotent" — this reads as
  reasoning-in-progress rather than a settled statement of intent. The logic
  itself is correct (confirmed by the dedicated jest case at
  `countDrafts.test.ts:63-70`); consider tightening the comment to state the
  invariant directly (a local-only candidate is always the push winner,
  regardless of its `unsynced` flag) rather than walking through the "what if"
  aloud.
- `src/lib/countDraftLocal.ts` vs `src/screens/staff/lib/countDrafts.ts` —
  the two `LocalCountDraft`/`LocalStaffDraft` types and their
  read/write/clear trios are structurally identical (same three fields, same
  shape-validator predicate, same try/catch-swallow posture) but independently
  hand-written twice with different names. This is the documented carve-out
  boundary working as intended (I/O duplicated, pure logic shared via
  `countDrafts.ts`) — not a violation — but flagging as an out-of-scope
  observation: `isLocalCountDraft`/`isLocalStaffDraft` are two copies of the
  same four-line predicate that could theoretically live in the shared pure
  module too (it takes no `supabase`/`AsyncStorage` dependency). (out-of-scope
  — no action needed for this spec; worth a mention if a future spec touches
  either file.)
- `src/screens/cmd/sections/InventoryCountSection.tsx:1014-1017` — the Save
  button's in-flight label is a bare literal `'SAVING…'` (not routed through
  `T()`), while every other label on the same button and its sibling Submit
  button uses the i18n catalog or is itself an existing bare literal (`'SUBMIT
  COUNT'`, line 1033, pre-existing). Given the file already mixes localized and
  hardcoded control labels, this isn't a regression, but the new Save button
  introduces one more hardcoded string right next to newly-added i18n keys
  (`section.countDraft.save`) — a `savingLabel` key would have been a one-line
  addition to the same new `countDraft` namespace already touched in this
  diff.
