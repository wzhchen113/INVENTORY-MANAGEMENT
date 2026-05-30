# Spec 073 — staff EOD defensive empty-state: align SafeAreaView edges

Status: READY_FOR_REVIEW
Shape: nit-cleanup (pure frontend, architect-flagged follow-up from spec 071)
Pipeline note: PM/architect ceremony skipped — change is a single-prop addition
that's been the same code-reviewer/architect-flagged item across specs 071 and
072. Reviewers + RC for the audit trail.

## Problem

`src/screens/staff/screens/EODCount.tsx:376` (the defensive `!activeStore`
empty-state branch) renders a `<SafeAreaView>` that's missing the
`edges={['top', 'bottom']}` prop the main render branch at line 390 has.
Without the prop, `react-native-safe-area-context` falls back to its default
`['top', 'bottom', 'left', 'right']` — adding left/right insets that the
populated branch doesn't carry. On a notched landscape phone the ActivityIndicator
would shift inward; in portrait the difference is invisible. Functionally
harmless but a cross-branch asymmetry that breaks the "two branches share
the same shape" invariant that made the spec-072 container fix cleanly land
on both branches at once.

## History

- Architect first surfaced this in spec 071's design review:
  > "Flagged one minor inconsistency: the defensive empty-state branch at
  > `EODCount.tsx:376-381` uses default (all-four) edges — out of scope for
  > 071, logged as a follow-up candidate."
- code-reviewer re-surfaced it as a Nit in spec 072 (`specs/072/reviews/code-reviewer.md`),
  explicitly noted as out-of-scope per spec 072 line 129.
- This spec resolves it.

## Fix

`src/screens/staff/screens/EODCount.tsx:376` — add the `edges` prop to match
the main branch:

```tsx
<SafeAreaView
  style={[styles.container, { backgroundColor: c.bgAlt }]}
  edges={['top', 'bottom']}
>
```

That's it. One prop. The styles object is unchanged; the branches now share
the SafeAreaView shape byte-for-byte (other than the obvious differing body).

## Verification

- `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
- `npx jest src/screens/staff` → 9 suites / 76 tests green (unchanged — the
  empty branch only renders on a transient `!activeStore` state which the
  existing tests don't exercise; pinning a single prop here would test the
  literal with zero behavioral value, so no test added per the same
  reasoning as the spec-072 `styles.container` decision).
- Visually unverifiable today — the empty branch is transient/defensive and
  was not reachable in the live preview session. The diff is one prop
  matching a known-correct sibling line in the same file.

## Files changed

- `src/screens/staff/screens/EODCount.tsx`
  - Line 376: `<SafeAreaView ...>` → multi-line form with
    `edges={['top', 'bottom']}` added. Total +3 / -1.

## Scope / non-changes

- StorePicker, the main EODCount render branch, the items FlatList, the
  styles object, the navigator, RoleRouter, admin stack — all untouched.
- No backend / RLS / RPC / edge function / migration / realtime / db.ts surface.
- Pure frontend. No prod migration. Vercel deploys on push.

## Out-of-scope (still open after 073 ships)

- `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID` repo secrets — needed to
  activate the spec-064 CI migration-drift gate. Manual GitHub-side step.
- In-tree browser E2E framework — there's no jest harness for
  viewport-sized list-scrolls-when-populated checks (deferred from spec 072).
  Bigger than a follow-up — needs its own PM conversation if pursued.
