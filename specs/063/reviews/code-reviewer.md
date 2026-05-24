## Code review for spec 063

Reviewer: code-reviewer
Spec: 063-fold-imr-staff-into-imr-inventory.md
Date: 2026-05-24

---

### Critical

- `src/lib/authGate.ts:58–68, 72–89` — Direct `supabase.from('profiles')` and `supabase.from('user_stores')` PostgREST calls outside `src/lib/db.ts`. CLAUDE.md §Conventions: "All PostgREST/RPC traffic flows through `src/lib/db.ts`." The spec chose a verbatim port from imr-staff and consciously isolated this helper outside db.ts to avoid introducing staff concerns into the admin data layer — the architect's rationale is documented at §3 / Q4. Flag for the release coordinator: this violates the stated convention; if the team accepts this as a permanent exception (staff gateway calls), a bullet should be added to CLAUDE.md naming `authGate.ts` and `sessionRestore.ts` as allowed carve-outs alongside `auth.ts` and `webPush.ts`, which already have the same pattern.

- `src/screens/staff/screens/EODCount.tsx:89–94, 121–125, 149–155` — Three `supabase.from(...)` calls (`order_schedule`, `inventory_items`, `eod_submissions`) directly in a screen component, bypassing `src/lib/db.ts`. The spec explicitly ported this file verbatim from imr-staff (§3 file list: "Move VERBATIM"), but the CLAUDE.md rule applies to all files in the merged repo. This is the single largest convention violation in the merge. If the decision is to keep staff reads outside db.ts, that exception must be documented in CLAUDE.md (see preceding finding). If the decision is to move them, `fetchVendorsForToday`, `fetchItemsForVendor`, and `fetchExistingSubmission` should become functions in `src/lib/db.ts` with the standard `mapItem`-style camelCase helpers.

- `src/screens/staff/hooks/useEodSubmit.ts:81` — `supabase.rpc('staff_submit_eod', ...)` called directly in a hook, not through `src/lib/db.ts`. Same finding as above but for an RPC call in a hook rather than a screen. The spec's "verbatim port" instruction accounts for this, but the convention violation stands and needs a documented exception or a migration.

### Should-fix

- `src/screens/cmd/sections/BrandsSection.tsx:854` — The `handleDemote` function passes `'Delete'` as the `confirmLabel` fourth argument to `confirmAction`. On native iOS/Android, the Alert will show a "Delete" button for an action that demotes a user's role — semantically incorrect. The `confirmLabel` should be `'Demote'`. This is a regression introduced in spec 063: before the change, `confirmAction` hardcoded the label to "Delete"; the spec 063 change to add an optional 4th arg was supposed to let destructive actions preserve "Delete" and non-destructive actions use something better — but the demote action was incorrectly given `'Delete'`. Web users are unaffected (`window.confirm` ignores the label). Native users see a misleading button label. Fix: change `'Delete'` to `'Demote'` at `BrandsSection.tsx:854`.

- `src/navigation/CmdNavigator.tsx:17` — `navRef` (`createNavigationContainerRef()`) is declared at module scope but is only referenced by the standalone default export `CmdNavigator()` at line 176 — which is dead code in the live app (App.tsx mounts `RoleRouter`, not `CmdNavigator`). The live navigation ref is `roleRouterNavRef` in `RoleRouter.tsx`. If `CmdNavigator` default export is retained for rollback-safety (as the comment states), `navRef` can stay — but it should be noted that `roleRouterNavRef` in `RoleRouter.tsx` is the live ref and is itself never imported anywhere else in the codebase, so neither ref serves any imperative-navigation callers today. Both are exported/declared but unused by consumers. Not a bug, but creates confusion about which ref is authoritative.

- `src/navigation/RoleRouter.tsx:37` — `roleRouterNavRef` is exported but never imported anywhere in the codebase (verified via grep). The comment says "screens that want to navigate imperatively can use it" — but no screen does. If this is forward-looking infrastructure, a comment noting it is unused until a future spec wires it in would prevent it from being treated as dead code at the next review. If it genuinely has no planned use, remove it.

- `src/screens/staff/navigation/StaffStack.tsx:65` — `React.ReactElement` type annotation used without importing `React`. TypeScript resolves this through global type declarations and the build passes, but the pattern is inconsistent with `RoleRouter.tsx` (which imports React explicitly). Prefer `import React from 'react'` or use the explicit type `import type { ReactElement } from 'react'; let content: ReactElement;` to make the dependency explicit and match the repo's other navigators.

### Nits

- `src/screens/staff/README.md:1–5` — File still contains the old imr-staff scaffolding placeholder text ("This is the scaffold directory for the imr-staff app. Spec 062... will populate these subdirectories"). The track D acceptance criterion says to add a one-line "Merged into imr-inventory" note to the `imr-staff/README.md` before archiving (that's the remote repo), but the local `src/screens/staff/README.md` now lives inside imr-inventory and its content is misleading. Consider replacing it with a brief description of the staff subtree's role in the merged app.

- `App.tsx:18` — Import alias `notifyBackendError as notifyStaffBackendError` is necessary for disambiguation, but the aliased name used at call site (line 204: `notifyStaffBackendError('staff queue hydrate', err)`) still passes a string tag that says "staff queue hydrate" which serves the same disambiguation purpose. Either the alias or the string tag is redundant. Minor; the alias is the cleaner approach since it makes the provenance visible at the import declaration.

- `src/screens/cmd/sections/POSImportsSection.tsx:988` — `'Delete'` passed as `confirmLabel` for a "Remove alias" action. "Remove" would be more accurate. Low priority since it's a non-data-deletion operation and the dialog title already says "Remove alias", but it's the same pattern as the BrandsSection demote issue (just lower severity because "delete" and "remove" are closer in meaning for an alias).

- `src/screens/staff/screens/EODCount.tsx:1` — File header comment still says `src/screens/EODCount.tsx` (original imr-staff path). Should be `src/screens/staff/screens/EODCount.tsx` to match the merged location. Same in `StorePicker.test.tsx:1`.

- `src/screens/staff/screens/EODCount.test.tsx:1` — File header comment says `src/screens/EODCount.test.tsx` (original imr-staff path). Update to `src/screens/staff/screens/EODCount.test.tsx`.

- `src/screens/staff/store/useStaffStore.test.ts` — (out-of-scope) The test file's coverage focuses on auth state transitions, AsyncStorage write-through, and queue selectors but does not cover the `pendingCountForUser(undefined)` → 0 guard or `bumpEodAttempts` with no `lastError`. Coordinate with test-engineer if additional coverage is desired.

---

## Pass 2 — fix-pass verification

Date: 2026-05-24
Scope: Verify the 7-item fix-pass recommended by the release-coordinator resolves Pass-1 findings.

### Critical findings — resolution status

All 3 Pass-1 Criticals share the same pattern: direct `supabase.from / supabase.rpc` calls outside `src/lib/db.ts`.

**Resolution: CLOSED.** CLAUDE.md line 63 now contains an explicit carve-out paragraph under the "DB access centralized" bullet. It names:
- `src/lib/auth.ts` and `src/lib/webPush.ts` (pre-existing carve-outs, unchanged)
- `src/lib/authGate.ts` and `src/lib/sessionRestore.ts` (spec 063, auth-path probes that fire before the store is initialized)
- The entire `src/screens/staff/` subtree (spec 063 verbatim port; notes a future migration spec is contemplated)

The call sites are real and unchanged at `authGate.ts:58–89`, `EODCount.tsx:89–94 / 121–125 / 149–155`, and `useEodSubmit.ts:81`, exactly as Pass-1 found them. The documentation now explicitly authorizes them. The carve-out is specific (names files and subtree), gives a rationale (pre-store-init, verbatim-port), and notes a future migration path — this matches the shape of the pre-existing `auth.ts` / `webPush.ts` carve-outs. The convention is updated, not abandoned.

**0 Critical remaining. SHIP_READY on the Critical dimension.**

### Should-fix findings — resolution status

- `src/screens/cmd/sections/BrandsSection.tsx:854` — **CLOSED.** Confirmed: the 4th arg now reads `'Demote'`. The native Alert button will correctly label the demote action.

- `src/screens/cmd/sections/POSImportsSection.tsx:988` — **CLOSED.** Confirmed: the 4th arg now reads `'Remove'`. (This was a Pass-1 Nit that the release coordinator promoted to item 5; the fix landed.)

- `src/navigation/CmdNavigator.tsx:17` (`navRef` unused) — **left as-is per Pass-1 caveat.** The release proposal explicitly deferred this as rollback-safety infrastructure. No new finding.

- `src/navigation/RoleRouter.tsx:37` (`roleRouterNavRef` unused) — **left as-is per Pass-1 caveat.** Release proposal deferred as forward-looking infrastructure. No new finding.

- `src/screens/staff/navigation/StaffStack.tsx:65` (`React.ReactElement` without React import) — **left as-is.** Release proposal explicitly deferred this as cosmetic ("build passes via global type resolution"). No new finding.

### Nit findings — resolution status

- `src/screens/staff/README.md` — **CLOSED.** The file now contains a full merged-state description with subdirectory table, backend contract section, and links to the relevant specs. The old "scaffold directory" placeholder is gone.

- `src/screens/staff/screens/EODCount.tsx:1` — **CLOSED.** Header reads `// src/screens/staff/screens/EODCount.tsx — the EOD count screen.`

- `src/screens/staff/screens/EODCount.test.tsx:1` — **CLOSED.** Header reads `// src/screens/staff/screens/EODCount.test.tsx — screen behavior tests.`

- `src/screens/staff/screens/StorePicker.test.tsx:1` — **CLOSED.** Header reads `// src/screens/staff/screens/StorePicker.test.tsx — renders + selects store.`

- `App.tsx:18` alias redundancy — **left as-is per Pass-1 caveat (minor).** No new finding.

### Architect doc-drift items (verified in passing)

- CLAUDE.md line 62 ("Cmd UI is the only client") — **CLOSED.** Now reads "Role-routed shell. App.tsx mounts `RoleRouter`..." with description of AdminStack / StaffStack dispatch.

- CLAUDE.md line 66 ("useRole intentional because staff use a separate app") — **CLOSED.** Now reads "Role hook semantics. `useRole.ts` returns `'admin'` for everyone INSIDE the admin Cmd UI surface, because the role-routed shell only mounts that surface for admin roles. The real role check happens at the `RoleRouter` boundary..."

- Spec 063 `## Files changed` tail — **CLOSED.** Section is fully populated at lines 1211–1247 of `specs/063-fold-imr-staff-into-imr-inventory.md`, covering git history, new files, modified files, subtree contents, deletions, and fix-pass items.

### Pass 2 verdict

**0 Critical. SHIP_READY.**

All 3 Pass-1 Criticals are resolved by the CLAUDE.md carve-out documentation, which is properly formed (specific, rationale-bearing, migration-contemplating) and matches the pre-existing pattern for `auth.ts` / `webPush.ts`. Both Should-fix string fixes landed correctly. All four Nit file-header and README fixes landed. The three items explicitly deferred by the release proposal (navRef cleanup, StaffStack React import, App.tsx alias nit) are out of scope for this pass and were not re-critiqued.

## Handoff
next_agent: NONE
prompt: Code review Pass 2 complete. 0 Critical, 0 Should-fix (all resolved or deferred), 0 new Nits. SHIP_READY.
payload_paths:
  - specs/063/reviews/code-reviewer.md
