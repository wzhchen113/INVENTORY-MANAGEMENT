// src/components/cmd/CountOrderDragList.nudge.test.tsx — Spec 103.
//
// Unit test for the native ▲/▼ "move" reorder math (the `nudge` helper). The
// web @dnd-kit path uses `arrayMove` (the library's own, already battle-tested);
// `nudge` is the only hand-rolled reorder logic, so it gets the focused
// coverage. The save-on-drop / apply contract is the same for both affordances
// (the spec's decided drag mechanism: @dnd-kit on web, ▲/▼ on native), so
// proving `nudge` produces the correct new id order is what guarantees the
// native path writes the same order the web drag would.
//
// `nudge` now lives in the shared dependency-free `src/lib/countOrder.ts` (next
// to `applyCountOrder`/`firstUncounted`) and is imported by BOTH the admin and
// staff `CountOrderDragList` wrappers (single source — code-review fix, spec 103
// review-fix pass). This test imports it directly from the shared module: no
// react-native / supabase boundary mock is needed because the shared module is
// pure (no `supabase`, no React). The `.test.tsx` extension is retained so the
// file keeps its place; the test itself has no JSX.

import { nudge } from '../../lib/countOrder';

describe('nudge (native ▲/▼ reorder)', () => {
  test('moving a row UP swaps it with the previous row', () => {
    expect(nudge(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  });

  test('moving a row DOWN swaps it with the next row', () => {
    expect(nudge(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  test('moving the FIRST row up is a no-op (returns null — out of bounds)', () => {
    expect(nudge(['a', 'b', 'c'], 0, -1)).toBeNull();
  });

  test('moving the LAST row down is a no-op (returns null — out of bounds)', () => {
    expect(nudge(['a', 'b', 'c'], 2, 1)).toBeNull();
  });

  test('moving the top row down then back up round-trips to the original order', () => {
    const down = nudge(['a', 'b', 'c'], 0, 1);
    expect(down).toEqual(['b', 'a', 'c']);
    // 'a' is now at index 1; nudging it up restores [a, b, c].
    expect(nudge(down as string[], 1, -1)).toEqual(['a', 'b', 'c']);
  });

  test('does not mutate the input array (returns a fresh array)', () => {
    const ids = ['a', 'b', 'c'];
    const out = nudge(ids, 1, -1);
    expect(ids).toEqual(['a', 'b', 'c']); // unchanged
    expect(out).not.toBe(ids);
  });
});
