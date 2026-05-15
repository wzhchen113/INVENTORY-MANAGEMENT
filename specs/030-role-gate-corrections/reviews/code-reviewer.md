## Code review for spec 030

### Critical

_None._

### Should-fix

- `src/components/TimezoneBar.tsx:8-10` — File-level comment says "admin / master → opens the timezone picker modal" but `super_admin` is now a third role that opens the modal (lines 24-27 grant it `isAdmin = true`). The comment is stale and will mislead the next developer who reads the file header before the body. Update to: `- admin / master / super_admin → opens the timezone picker modal (writes to useStore)`.

- `specs/030-role-gate-corrections/spec.md:AC1.1 (lines 22-28)` — AC1.1 still reads "replaced with a call to `useIsMaster()`" but the Implementation note at lines 527-546 documents a user-approved correction that swaps the direction to inline-widening. The built artifact correctly follows the correction, but the AC text was never updated to reflect it. A reader verifying AC1.1 will see a mismatch between the acceptance criterion and the code. Either update AC1.1 to describe the inline-widen shape or add a visible note at the top of the AC that it was superseded by the Implementation note. (Note: spec files are the contract — leaving a contradicted AC open creates confusion for future reviewers and the release-coordinator.)

### Nits

- `src/lib/cmdSelectors.ts:1028-1031` — The existing comment block above `useDefaultSidebarGroups()` (the spec 012b rationale) describes only the `isSuperAdmin` / Brands gating. The new `isMaster` / Admin gating added in spec 030 is explained inline at lines 1080-1084 but nowhere in the opening comment block. A reader scanning just the function signature and its lead comment won't know a second gate now exists. Consider extending the comment to mention both gates, or add one sentence: "Spec 030 adds an analogous `isMaster` gate for the Admin group."

- `src/components/TimezoneBar.tsx:24-27` — The local variable is named `isAdmin` but it now returns `true` for `master` and `super_admin` in addition to `admin`, making the name slightly misleading (the original pre-030 shape where `admin` and `master` gated this was also slightly misleading, so this isn't a regression — the spec explicitly called the optional rename `canEditTz` and the dev chose to keep `isAdmin`). No action required per AC1.1's "optional rename" clause; surfaced for awareness only.
