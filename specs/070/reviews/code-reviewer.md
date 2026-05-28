# Code review — spec 070 (staff app UI/UX redesign)

Reviewer: code-reviewer
Scope: pure-frontend re-skin + OS-driven dark mode. No backend / SQL / auth / RLS surface.

> Recovered verbatim from the reviewer's returned text (the agent emitted
> findings inline rather than writing this file — same recurring conflict
> seen on specs 055/065/069). Resolution notes added by main Claude after
> the FE fix-pass — see the **Resolution** block at the end.

## Critical

None. Verified: no direct Supabase calls outside the documented staff carve-out,
no legacy-file edits, no `app.json` slug change, no `profiles.dark_mode` write
from the staff surface, no unguarded `window`/`document`/`navigator` in new code,
no new realtime channels, no direct `Alert.alert`.

## Should-fix

1. **`src/screens/staff/components/Banner.tsx:53` / `EODCount.tsx:441,445`** —
   `Banner` gained `borderRadius: radius.lg` (16px) in spec 070 for the "soft
   card" look, but neither the component nor its two `EODCount` call sites apply
   a `marginHorizontal`. The banner renders flush to the safe-area edges, so the
   rounded corners exist in the computed style but are occluded at the screen
   edges — the §6 card-corner intent is silently unrealized. Fix: add
   `marginHorizontal: spacing.lg` to `styles.banner` (preferred — keeps call
   sites clean) or wrap each `<Banner>` in a padded `View`.

2. **`src/screens/staff/components/Button.tsx:99`** — `styles.primary` is an
   empty `{}` registered in `StyleSheet.create` and applied on every primary
   render (`isPrimary ? styles.primary : styles.secondary`). An empty StyleSheet
   entry is dead code: it implies primary has its own structural rules when it
   doesn't (the fill + lift come from `containerColor()` + `e.card`). Either give
   it structural props or drop the entry and skip it in the style array.

## Nits

1. **`EODCount.tsx:622`** — `minHeight: 44` hardcoded on `signOutBtn`; every
   other touch target uses `touchTarget.min`. Replace with `touchTarget.min`.
   (NB: `touchTarget` was not actually imported in EODCount — the import line
   needs it added too.)

2. **`Banner.tsx:36`** — `makeToneStyles(c)` allocates a full 4-entry record per
   render and discards 3. Harmless for a single-banner component; could be a
   direct lookup / `switch(tone)`. Current form is clear — optional.

3. **`ListRow.tsx:39`** — three `useColorScheme()` subscriptions in one render
   (`useStaffColors`, `useStaffElevation`, and a direct call for the dark
   boolean). Spec explicitly allowed the direct call; all three return the same
   value. Note for a future hook-consolidation refactor.

4. **(out-of-scope) `StorePicker.tsx`** — root is `<View>` not `<SafeAreaView>`;
   header title may overlap the status bar on notched devices. Pre-existing from
   spec 062, not introduced here. Candidate follow-up.

## Resolution (post-review FE fix-pass — main Claude)

- Should-fix #1 — **fixed.** `marginHorizontal: spacing.lg` added to
  `styles.banner` (Banner is only ever a full-width screen sibling in EODCount,
  so the inset lives on the component). DOM/visual gutter now matches the cards.
- Should-fix #2 — **fixed.** Empty `primary: {}` removed; style array now uses
  `!isPrimary && styles.secondary` so only the outline variant carries
  structural chrome.
- Nit #1 — **fixed.** `touchTarget` added to the EODCount theme import;
  `signOutBtn.minHeight` now `touchTarget.min`.
- Nits #2/#3 — left as-is (reviewer marked optional / spec-sanctioned).
- Nit #4 — out of scope for 070; logged as a follow-up candidate.

## Handoff
next_agent: NONE
