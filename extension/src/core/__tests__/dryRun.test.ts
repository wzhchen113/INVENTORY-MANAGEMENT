import { describe, it, expect } from 'vitest';
import { actionsToExecute, canMarkOrdered } from '../dryRun';
import type { PlannedAction } from '../../lib/types';

function action(overrides: Partial<PlannedAction>): PlannedAction {
  return {
    itemId: 'i1',
    orderCode: 'C1',
    itemName: 'Item',
    qty: 1,
    unit: 'unit',
    productPageUrl: null,
    resolution: 'search',
    ...overrides,
  };
}

describe('actionsToExecute (AC-10 — the dry-run gate performs NO cart side effect)', () => {
  const plan: PlannedAction[] = [
    action({ itemId: 'a', resolution: 'search' }),
    action({ itemId: 'b', resolution: 'url', productPageUrl: 'https://www.bjs.com/p/1' }),
    action({ itemId: 'c', resolution: 'unmapped', orderCode: null }),
  ];

  it('returns NO actions in dry-run (no add-to-cart side effect)', () => {
    expect(actionsToExecute(plan, true)).toEqual([]);
  });

  it('returns only the resolvable actions in a live run (drops unmapped)', () => {
    expect(actionsToExecute(plan, false).map((a) => a.itemId)).toEqual(['a', 'b']);
  });
});

describe('canMarkOrdered (AC-10 — the SAME gate governs the mark-ordered write)', () => {
  it('forbids the write-back in dry-run', () => {
    expect(canMarkOrdered(true)).toBe(false);
  });
  it('allows the write-back in a live run', () => {
    expect(canMarkOrdered(false)).toBe(true);
  });
});
