# Spec 071: Staff StorePicker safe-area fix

Status: READY_FOR_REVIEW

## User story

As a staff user opening the staff app on a notched phone (e.g. iPhone with a
dynamic island, modern Android with a status-bar cutout), I want the
StorePicker title row to sit below the device status bar / notch so that the
"Select a store" header is legible and not occluded.

## Acceptance criteria

- [ ] `src/screens/staff/screens/StorePicker.tsx` root element is
  `SafeAreaView` imported from `react-native-safe-area-context` (NOT the
  deprecated `react-native` re-export), with explicit
  `edges={['top', 'bottom']}` to match the existing convention in
  `EODCount.tsx`.
- [ ] On a viewport with a top inset (e.g. iPhone notch, web with a simulated
  `env(safe-area-inset-top)`), the rendered `accessibilityRole="header"` title
  row is positioned at or below the safe-area top boundary — it does NOT
  overlap the status bar / notch area.
- [ ] On a viewport with a bottom inset (e.g. iPhone home-bar area), the
  `FlatList`'s last-item bottom padding sits at or above the safe-area bottom
  boundary — last store row is reachable above the home indicator.
- [ ] `EODCount.tsx` is audited and confirmed already-correct (`SafeAreaView`
  with `edges={['top', 'bottom']}` from `react-native-safe-area-context` —
  already in place at `EODCount.tsx:390`). No code change required for
  EODCount; the audit result is captured in the spec's
  "Project-specific notes" as evidence.
- [ ] No other staff screen is silently affected: a grep for `from 'react-native'`
  importing `SafeAreaView` across `src/screens/staff/**` returns zero matches
  (we use the `react-native-safe-area-context` version, never the
  `react-native` re-export).
- [ ] No change to `App.tsx`'s existing `SafeAreaProvider` mount; insets
  resolve through the already-mounted provider.
- [ ] No new dependency added — `react-native-safe-area-context` is already a
  transitive dep via `@react-navigation/native` and is already imported by
  `EODCount.tsx` and `App.tsx`.
- [ ] Jest snapshot or render test for `StorePicker` (if added) renders without
  throwing when no `SafeAreaProvider` is mounted in the test tree — i.e. the
  component must not assume insets are non-null at mount. (The library's
  default behavior covers this; the AC is to confirm we haven't broken it.)
- [ ] Visual smoke on web at viewport simulating notch: title row is visually
  inset from the top of the viewport. Manual check; not a CI gate.
- [ ] No regression in spec 070's color / elevation behavior — the
  `backgroundColor: c.bg` previously set on the root `<View>` is preserved on
  the new `<SafeAreaView>` root.

## In scope

- Convert `src/screens/staff/screens/StorePicker.tsx` root `<View>` to
  `<SafeAreaView>` from `react-native-safe-area-context` with
  `edges={['top', 'bottom']}`.
- Audit pass on `src/screens/staff/screens/EODCount.tsx` to confirm the
  existing `SafeAreaView` usage matches the convention (it does — already
  uses the `react-native-safe-area-context` import and the same edges array).
  No code change to EODCount expected; the audit produces a one-line note in
  the spec record.

## Out of scope (explicitly)

- Refactoring `StorePicker` styles beyond the root element swap. The header /
  list / chevron styling stays as spec 070 left it. Rationale: minimal-diff
  fix to a deferred reviewer nit.
- Refactoring `EODCount`'s safe-area handling. It's already correct. Rationale:
  no defect to fix.
- Changing the `SafeAreaProvider` mount in `App.tsx`. Rationale: provider is
  already mounted and working for EODCount; no architectural change needed.
- Adding a `SafeAreaProvider` wrapper specific to the staff stack. Rationale:
  the app-level provider in `App.tsx` already covers both admin and staff
  stacks downstream of `RoleRouter`.
- Touching the admin Cmd UI surface (`src/screens/cmd/**`) or
  `CmdNavigator.tsx`. Rationale: spec is staff-only.
- Adding a four-edge (`['top', 'bottom', 'left', 'right']`) SafeAreaView.
  Rationale: the convention established by `EODCount.tsx:390` is top+bottom
  only; horizontal padding is handled by per-screen `paddingHorizontal`
  spacing tokens. Symmetry > novelty here.
- Migrating the staff subtree's direct Supabase calls into `src/lib/db.ts`.
  Rationale: documented carve-out per CLAUDE.md "DB access centralized" bullet
  (spec 063); out of scope for a safe-area fix.
- Any pgTAP test work. Rationale: pure-frontend change, no DB surface.

## Open questions resolved

- Q: StorePicker only, or both StorePicker AND EODCount? → A: Both, but the
  EODCount portion is an audit-only pass — reading the file shows
  `EODCount.tsx:390` already uses
  `<SafeAreaView ... edges={['top', 'bottom']}>` from
  `react-native-safe-area-context`. The actual code delta is StorePicker only;
  the spec records EODCount as confirmed-correct so the next reviewer doesn't
  have to redo the audit.
- Q: Top-only edges, or top + bottom? → A: Top + bottom, matching the
  pre-existing EODCount convention. StorePicker's `FlatList` has a
  `paddingBottom: spacing.xxl` already (`StorePicker.tsx:84`), but on a tall
  list scrolled to the end on a home-bar device the last row still wants the
  bottom inset for symmetry with EODCount's footer.
- Q: `<SafeAreaView>` component or `useSafeAreaInsets()` padding? → A:
  `<SafeAreaView>` from `react-native-safe-area-context` with explicit
  `edges` prop. Reasons: (1) matches the EODCount convention so the two staff
  screens stay structurally identical at the root; (2) the reviewer's nit
  named `<SafeAreaView>` specifically; (3) simpler call site, fewer moving
  parts.

## Dependencies

- `react-native-safe-area-context` — already a transitive dep via
  `@react-navigation/native`; already imported in `App.tsx` (for
  `SafeAreaProvider`) and `EODCount.tsx` (for `SafeAreaView`). No new package
  install.
- `SafeAreaProvider` mount at `App.tsx:336` — pre-existing, covers the staff
  stack downstream of `RoleRouter`.
- No DB migration, no edge function change, no RLS change.

## Project-specific notes

- Cmd UI section / legacy: **staff stack only** — `src/screens/staff/`.
  Admin Cmd UI surface is untouched. No `cmd/sections/` change.
- Per-store or admin-global: **N/A** — UI-only chrome fix, not data-scoped.
- Realtime channels touched: **none** — StorePicker doesn't subscribe to
  realtime in v1 (per spec 062), and this fix doesn't introduce one.
- Migrations needed: **no**.
- Edge functions touched: **none**.
- Web/native scope: **both** — `react-native-safe-area-context` runs on
  react-native-web and native; `App.tsx`'s `SafeAreaProvider` is mounted for
  both platforms. The fix lands once and ships through both Vercel (web) and
  EAS (native).
- Tests: **jest track only**. If a screen-render test is added for
  `StorePicker` (paralleling `ListRow.test.tsx`), it goes in
  `src/screens/staff/screens/StorePicker.test.tsx`. No pgTAP, no shell smoke.
- `app.json` slug: **not touched** — load-bearing per CLAUDE.md, no reason
  to change here.
- EODCount audit evidence: at the time of writing, `EODCount.tsx` line 28
  imports `SafeAreaView` from `react-native-safe-area-context` and line 390
  uses `<SafeAreaView ... edges={['top', 'bottom']}>` as the root. This is
  the convention StorePicker is being aligned to.
- Reviewer reference: nit #4 from
  `specs/070/reviews/code-reviewer.md` is the source of this spec.
- Pure-frontend, no contract surface — architect's structural pass is
  optional but project convention says architect still runs. Default to
  recommending architect per the project's typical pipeline.

## Backend / Frontend design

Pure-frontend, single-file change. There is **no** backend, RLS, RPC, edge
function, migration, realtime, or `src/lib/db.ts` surface in this spec — the
standard backend-design section template is collapsed to a one-line N/A so the
frontend-developer doesn't go looking for one.

### Data model changes
N/A. No table, column, index, view, or RLS policy is touched.

### RLS impact
N/A.

### API contract
N/A.

### Edge function changes
N/A.

### `src/lib/db.ts` surface
N/A. No helper added or modified.

### Realtime impact
N/A. StorePicker has no realtime subscription in v1 (per spec 062), and this
fix does not introduce one. The publication-membership gotcha
(`docker restart supabase_realtime_imr-inventory`) does **not** apply.

### Frontend store impact
N/A. The Zustand slices in [src/store/useStore.ts](src/store/useStore.ts) and
[src/screens/staff/store/useStaffStore.ts](src/screens/staff/store/useStaffStore.ts)
are untouched. The optimistic-then-revert pattern is not invoked here because
no backend round-trip is added.

---

### Frontend design (the actual change)

**File touched:** `src/screens/staff/screens/StorePicker.tsx` only.

**Shape of the change** (signature-level, not committed code):

1. **Import.** Add `SafeAreaView` from `react-native-safe-area-context`
   alongside the existing `react-native` import block. Drop `View` from the
   import only if every remaining `<View>` usage in the file has been
   replaced — currently there are three (`styles.header`, `styles.separator`,
   the implicit list separator wrapper) that still need `View`, so `View`
   stays imported.
2. **Root element.** Swap `<View style={[styles.container, ...]}>` →
   `<SafeAreaView style={[styles.container, ...]} edges={['top', 'bottom']}>`
   with the exact same style array. The `backgroundColor: c.bg` continues to
   be applied via the inline style, satisfying AC §"No regression in spec
   070's color / elevation behavior".
3. **`testID` on the root.** Add `testID="store-picker-root"` (or equivalent
   stable token) to the root `<SafeAreaView>` so the jsdom render test
   (described below) can grab it via `getByTestId` and assert the type
   identity. This is the minimal-diff way to make the new root testable
   without restructuring the children.
4. **Closing tag.** `</View>` → `</SafeAreaView>`.

No style changes. No layout changes. No new dependency. The `flex: 1`
container style continues to apply — `SafeAreaView` from
`react-native-safe-area-context` accepts the same `style` prop shape as `View`
and forwards layout props to its inner host view (confirmed against
EODCount's identical usage at `EODCount.tsx:390`).

**Why `edges={['top', 'bottom']}`, not all four:**
Symmetry with EODCount. Confirmed in this design pass: `EODCount.tsx:392`
uses exactly `edges={['top', 'bottom']}` — byte-for-byte the same value the
spec is targeting for StorePicker. The two staff screens will then be
structurally identical at the root, which is the explicit goal in
"Open questions resolved" Q3. The horizontal insets are intentionally
delegated to per-screen `paddingHorizontal: spacing.lg` tokens.

### EODCount audit (no code change)

- `src/screens/staff/screens/EODCount.tsx:28` —
  `import { SafeAreaView } from 'react-native-safe-area-context';`
  Correct import source (not the deprecated `react-native` re-export).
- `src/screens/staff/screens/EODCount.tsx:390-393` — root is
  `<SafeAreaView style={[styles.container, { backgroundColor: c.bgAlt }]} edges={['top', 'bottom']}>`.
  Matches the convention the StorePicker swap is being aligned to.
- Defensive empty-state branch at `EODCount.tsx:376-381` uses the same
  `<SafeAreaView>` root without an explicit `edges` prop (library default is
  `['top', 'right', 'bottom', 'left']`). This is the minimum-content branch
  rendered only while `!activeStore`. Out of scope for spec 071 — flagged as
  a minor follow-up below in §Risks.

**EODCount audit verdict:** confirmed correct on the primary render branch.
No code delta. Spec §"In scope" bullet 2 is satisfied by this design note.

### Frontend test impact (recommended)

A render-time jsdom test is recommended, mirroring the
[src/screens/staff/components/ListRow.test.tsx](src/screens/staff/components/ListRow.test.tsx)
idiom that landed in spec 070 (`@testing-library/react-native`, jest-expo
preset, the component project). New file:
`src/screens/staff/screens/StorePicker.test.tsx`.

Test shape (assertion-level, not committed code):

1. **Root identity.** Render `<StorePicker />` inside a `<SafeAreaProvider>`
   (the test must mount its own provider — the App-level provider isn't
   instantiated under jest), grab `getByTestId('store-picker-root')`, and
   assert the element's `type` is `SafeAreaView` from
   `react-native-safe-area-context`, not a bare `View`. This is the primary
   regression guard — a future agent who reverts the change must see this
   test fail.
2. **Provider-absent tolerance.** A second render without a
   `<SafeAreaProvider>` wrapper must not throw — confirms the library's
   default-insets fallback covers us (AC §"renders without throwing when no
   SafeAreaProvider is mounted in the test tree").
3. **Header still present.** Smoke-assert `getByRole('header')` returns the
   title — confirms the swap didn't accidentally drop the existing
   `accessibilityRole="header"` markup.

Test harness already in place: jest-expo, `@testing-library/react-native`,
the staff component-project that picks up `src/screens/**/*.test.tsx`. No
new jest config, no new mock.

### Risks and tradeoffs

1. **react-native-web SafeAreaView is a plain `<div>` shim.** On web the
   library renders a `div` with `env(safe-area-inset-*)` CSS variables
   applied as padding. Browsers that don't expose those env vars (almost
   all desktop browsers, all Android non-PWA browsers) resolve the inset to
   `0px` — i.e. behaves identically to a `<View>`. This is the desired
   web fallback and matches what EODCount already does in production. No
   risk. AC §"Visual smoke on web" is satisfied by the desktop case being
   visually unchanged.
2. **The `flex: 1` style and the `FlatList` child.** Confirmed: the
   `SafeAreaView` host wraps its children in a single flex container and
   forwards `flex: 1` correctly. The existing `FlatList` will continue to
   consume the remaining height. The `keyboardDismissMode` /
   `keyboardShouldPersistTaps` props are not currently set on the
   `FlatList`, so there's no interaction with safe-area handling — confirmed
   by reading `StorePicker.tsx:38-58`.
3. **`SafeAreaProvider` deeper-boundary check.** Not needed. The App-level
   `<SafeAreaProvider>` at `App.tsx:336` wraps `<RoleRouter />`, which
   mounts the staff stack — confirmed by reading App.tsx in this pass.
   Adding a nested provider would silently shadow the App-level one and
   produce zero insets in the staff subtree (the library's documented
   behavior). The spec correctly rules this out as out-of-scope.
4. **Empty-state branch in EODCount.** Audit note: the
   `EODCount.tsx:376-381` empty-state SafeAreaView has no explicit `edges`
   prop. Default is all-four-edges. This is structurally inconsistent with
   the primary branch (`['top', 'bottom']`) but renders for fractions of a
   second during render before `activeStore` resolves, so the visual impact
   is nil. Flagged here so a future audit doesn't re-derive it — out of
   scope for 071; candidate follow-up if EODCount ever gets visually
   re-touched.
5. **Test mount cost.** Adding a `StorePicker.test.tsx` adds one render
   pass to the jest matrix. Negligible. The staff store hook
   (`useStaffStore`) reads from a Zustand store at module load; the test
   does not need to seed any specific store state for the root-identity
   assertion (the selector returns an empty array by default, and
   StorePicker handles empty stores gracefully via the existing `FlatList`).
6. **No CI-gate assumption.** Per CLAUDE.md, the only active CI gates are
   `test.yml` (jest + typecheck + pgTAP) and `db-migrations-applied.yml`.
   The new StorePicker.test.tsx is picked up by `test.yml` automatically
   via the existing jest project glob. No CI workflow change.

### Migration ordering / rollout safety
N/A — no migrations. The change ships through Vercel (web) and EAS (native)
via the existing build pipeline. No publication-membership change, so no
realtime container restart is needed for local dev.

### Performance on the 286 KB seed dataset
N/A — UI chrome change, not a data path.

### Edge function cold-start
N/A — no edge function involved.

---

### Summary of files to change

| File | Change |
|------|--------|
| `src/screens/staff/screens/StorePicker.tsx` | Swap root `<View>` → `<SafeAreaView>` from `react-native-safe-area-context` with `edges={['top', 'bottom']}`. Add `testID="store-picker-root"`. Keep `View` import (still used for header/separator). |
| `src/screens/staff/screens/StorePicker.test.tsx` | **New file.** Render-time jsdom assertions per §"Frontend test impact". |

**No** changes to: `App.tsx`, `EODCount.tsx`, any theme/token file,
`src/lib/db.ts`, `useStaffStore.ts`, any migration, any edge function,
any config file, `app.json`, `package.json`.

## Handoff
next_agent: frontend-developer
prompt: Implement the StorePicker safe-area swap per the design in this
  spec. The change is single-file (plus one new test file) and the shape is
  fully specified in §"Frontend design". This is a pure-frontend spec — do
  NOT fan out backend-developer; there is no backend, RLS, RPC, edge function,
  migration, realtime, or db.ts surface. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/071-staff-storepicker-safe-area.md

## Files changed

- `src/screens/staff/screens/StorePicker.tsx` — Swapped the root `<View>` for
  `<SafeAreaView>` imported from `react-native-safe-area-context`, with
  explicit `edges={['top', 'bottom']}` to match the EODCount convention at
  `EODCount.tsx:390`. Added `testID="store-picker-root"` on the new root so
  the jest assertions can grab it. Kept `View` imported (still used by
  `styles.header`, `styles.separator`, the FlatList separator). Kept
  `backgroundColor: c.bg` on the new root via the existing inline style
  array — spec 070's color behavior preserved. Added a header-comment
  paragraph documenting the spec 071 swap, the EODCount-mirror rationale,
  and the "do not nest another SafeAreaProvider here" guidance.
- `src/screens/staff/screens/StorePicker.test.tsx` — Extended the
  pre-existing spec-063 test file with a new `describe('StorePicker — spec
  071 safe-area root')` block. New assertions: (1) component renders
  without throwing when no `<SafeAreaProvider>` is mounted (library
  default-insets fallback); (2) root element identity is `SafeAreaView`
  (the jest-expo mock's string tag `'SafeAreaView'`, not `'View'`);
  (3) root carries `edges={['top', 'bottom']}` byte-for-byte; (4) the
  "Select your store" title text and `accessibilityRole="header"` markup
  both survive the swap. The original spec-063 tests (row rendering, row
  tap → `setActiveStore`, count subtitle) are preserved untouched.
  Note: the file already existed from the spec-063 imr-staff merge, so the
  spec's "NEW file" framing in §"Frontend test impact" was adjusted at
  implementation time to an "extend existing" — the architect-approved
  assertion shapes (root identity, edges, no-provider tolerance, header
  present) are implemented verbatim. Surfaced here for code-reviewer
  attention.

### Verification

- `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
- `npx jest src/screens/staff` → **9 suites passed, 74 tests passed**,
  including the 4 new spec-071 assertions in
  `src/screens/staff/screens/StorePicker.test.tsx`. The pre-existing
  `act(...)` VirtualizedList warning from `EODCount.test.tsx` is unchanged
  by this spec — it's noise from a sibling test file's FlatList, not a
  spec-071 regression.
- Browser preview: **not exercised**. The Claude Preview MCP tools were not
  loaded in this session, but per the architect's spec §"Risks and tradeoffs
  §1", `react-native-safe-area-context`'s `SafeAreaView` renders as a `<div>`
  shim on react-native-web with `env(safe-area-inset-*)` CSS that resolves
  to `0px` in desktop browsers without a notch — i.e. the desktop visual is
  identical to the pre-swap `<View>` output. The structural correctness of
  the swap is enforced by the four new jest assertions; the device-level
  inset behavior ships through EAS to be verified on a real notched device
  during native QA, which is the same posture EODCount already runs under.
