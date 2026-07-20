import { describe, it, expect } from 'vitest';
import { assembleReport, summarizeReport } from '../report';
import type { ExecutionResult, PlannedAction } from '../../lib/types';

function action(overrides: Partial<PlannedAction>): PlannedAction {
  return {
    itemId: 'i1',
    orderCode: 'C1',
    itemName: 'Item',
    qty: 2,
    unit: 'case',
    productPageUrl: null,
    resolution: 'search',
    ...overrides,
  };
}

const plan: PlannedAction[] = [
  action({ itemId: 'ok', resolution: 'search' }),
  action({ itemId: 'gap', resolution: 'unmapped', orderCode: null, itemName: 'Mystery' }),
  action({ itemId: 'urlItem', resolution: 'url', productPageUrl: 'https://www.bjs.com/p/9' }),
];

describe('assembleReport (AC-7 — per-item report)', () => {
  it('renders would-add for resolvable lines in dry-run, unmatched for gaps (AC-10)', () => {
    const report = assembleReport(plan, [], true);
    const byId = Object.fromEntries(report.map((r) => [r.itemId, r.status]));
    expect(byId).toEqual({ ok: 'would-add', gap: 'unmatched', urlItem: 'would-add' });
  });

  it('maps live execution outcomes to added / ambiguous / failed', () => {
    const results: ExecutionResult[] = [
      { itemId: 'ok', outcome: 'added', detail: 'in cart' },
      { itemId: 'urlItem', outcome: 'ambiguous', detail: '3 results' },
    ];
    const report = assembleReport(plan, results, false);
    const byId = Object.fromEntries(report.map((r) => [r.itemId, r.status]));
    expect(byId).toEqual({ ok: 'added', gap: 'unmatched', urlItem: 'ambiguous' });
  });

  it('reports a resolvable line with no execution result as failed (fail-loud, never dropped)', () => {
    const report = assembleReport(plan, [], false);
    expect(report.find((r) => r.itemId === 'ok')?.status).toBe('failed');
  });

  it('always reports an unmapped line as unmatched regardless of mode (AC-5)', () => {
    expect(assembleReport(plan, [], true).find((r) => r.itemId === 'gap')?.status).toBe('unmatched');
    expect(assembleReport(plan, [], false).find((r) => r.itemId === 'gap')?.status).toBe('unmatched');
  });

  it('preserves plan order and carries qty/unit/orderCode through', () => {
    const report = assembleReport(plan, [], true);
    expect(report.map((r) => r.itemId)).toEqual(['ok', 'gap', 'urlItem']);
    expect(report[0]).toMatchObject({ qty: 2, unit: 'case', orderCode: 'C1' });
  });
});

describe('summarizeReport', () => {
  it('counts by status', () => {
    const report = assembleReport(plan, [{ itemId: 'ok', outcome: 'added', detail: '' }], false);
    const s = summarizeReport(report);
    expect(s).toMatchObject({ added: 1, unmatched: 1, failed: 1, total: 3 });
  });
});
