// src/utils/poShareText.test.ts — Spec 108 (D-4).
//
// Pins the PURE "Share PO" text builder byte-for-byte: the header block, one
// `{qty} × {unit} {name}` line per PO line (in input order), the trailing
// localized `N items` count, the empty-lines edge, the injected-resolver name
// resolution, the localized-labels bundle (the deliberate extension), and the
// hard no-`$` invariant (no money ever enters the vendor-facing text).

import { buildPoShareText, type PoShareInput, type PoShareLabels, type NameResolver } from './poShareText';

// English reference labels — mirrors what the caller resolves via T() for `en`.
const EN_LABELS: PoShareLabels = {
  header: 'I.M.R — Purchase order',
  storeLabel: 'Store',
  dateLabel: 'Date',
  itemsCount: '2 items',
  noItems: '(no items)',
};

// A resolver that returns names verbatim by id (the caller's closure over
// `inventory` + locale is exercised separately below).
const byId = (map: Record<string, string>): NameResolver => (itemId, fallbackName) =>
  map[itemId] ?? fallbackName;

describe('buildPoShareText — template pin', () => {
  it('emits header + one line per item + trailing count, byte-for-byte', () => {
    const input: PoShareInput = {
      storeName: 'Towson',
      referenceDate: '2026-07-03',
      lines: [
        { itemId: 'a', itemName: 'Chicken Thigh EN', orderedQty: 3, unit: 'case' },
        { itemId: 'b', itemName: 'Yellow Onion EN', orderedQty: 12, unit: 'lb' },
      ],
    };
    const out = buildPoShareText(input, EN_LABELS, byId({ a: 'Chicken Thigh', b: 'Yellow Onion' }));
    expect(out).toBe(
      [
        'I.M.R — Purchase order',
        'Store: Towson',
        'Date: 2026-07-03',
        '',
        '3 × case Chicken Thigh',
        '12 × lb Yellow Onion',
        '',
        '2 items',
      ].join('\n'),
    );
  });

  it('uses the U+00D7 multiplication sign (not a lowercase x)', () => {
    const out = buildPoShareText(
      { storeName: 'S', referenceDate: '2026-01-01', lines: [{ itemId: 'a', itemName: 'A', orderedQty: 1, unit: 'ea' }] },
      { ...EN_LABELS, itemsCount: '1 items' },
      byId({ a: 'Widget' }),
    );
    expect(out).toContain('1 × ea Widget');
    // The body line must NOT use a plain ASCII 'x' as the separator.
    expect(out).not.toContain('1 x ea Widget');
  });

  it('collapses inner whitespace when the unit is blank (no double space)', () => {
    const out = buildPoShareText(
      { storeName: 'S', referenceDate: '2026-01-01', lines: [{ itemId: 'a', itemName: 'A', orderedQty: 5, unit: '' }] },
      { ...EN_LABELS, itemsCount: '1 items' },
      byId({ a: 'Salt' }),
    );
    // `5 × <blank> Salt` collapses to `5 × Salt` — no `× ` double gap.
    expect(out).toContain('5 × Salt');
    expect(out).not.toMatch(/× {2}/);
  });

  it('reuses formatQty (2-decimal, trailing-zero-stripped)', () => {
    const out = buildPoShareText(
      { storeName: 'S', referenceDate: '2026-01-01', lines: [{ itemId: 'a', itemName: 'A', orderedQty: 2.5, unit: 'lb' }] },
      { ...EN_LABELS, itemsCount: '1 items' },
      byId({ a: 'Beef' }),
    );
    expect(out).toContain('2.5 × lb Beef');
  });
});

describe('buildPoShareText — resolver + fallback (OQ-2)', () => {
  it('routes every name through resolveName (never emits itemName verbatim)', () => {
    const resolver = jest.fn<string, [string, string]>((_id, _fallback) => 'RESOLVED');
    const out = buildPoShareText(
      {
        storeName: 'S',
        referenceDate: '2026-01-01',
        lines: [{ itemId: 'x1', itemName: 'PLAIN ENGLISH', orderedQty: 1, unit: 'ea' }],
      },
      { ...EN_LABELS, itemsCount: '1 items' },
      resolver,
    );
    // Called with (itemId, itemName-as-fallback).
    expect(resolver).toHaveBeenCalledWith('x1', 'PLAIN ENGLISH');
    expect(out).toContain('1 × ea RESOLVED');
    // The raw plain-English name is never emitted when the resolver overrides it.
    expect(out).not.toContain('PLAIN ENGLISH');
  });

  it('falls back to itemName when the resolver returns the fallback', () => {
    // Resolver that has no translation → returns the fallback it was given.
    const out = buildPoShareText(
      {
        storeName: 'S',
        referenceDate: '2026-01-01',
        lines: [{ itemId: 'missing', itemName: 'English Only', orderedQty: 2, unit: 'ea' }],
      },
      { ...EN_LABELS, itemsCount: '1 items' },
      (_id, fallbackName) => fallbackName,
    );
    expect(out).toContain('2 × ea English Only');
  });
});

describe('buildPoShareText — localized labels (deliberate extension)', () => {
  it('emits the passed-in localized fixed strings (whole message follows locale)', () => {
    // zh-CN-style labels + zh item name — the WHOLE message is Chinese.
    const zhLabels: PoShareLabels = {
      header: 'I.M.R — 采购单',
      storeLabel: '门店',
      dateLabel: '日期',
      itemsCount: '共 1 项',
      noItems: '（暂无项目）',
    };
    const out = buildPoShareText(
      { storeName: '陶森店', referenceDate: '2026-07-03', lines: [{ itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3, unit: 'case' }] },
      zhLabels,
      byId({ a: '鸡腿肉' }),
    );
    expect(out).toBe(
      ['I.M.R — 采购单', '门店: 陶森店', '日期: 2026-07-03', '', '3 × case 鸡腿肉', '', '共 1 项'].join('\n'),
    );
  });
});

describe('buildPoShareText — empty-lines edge (AC)', () => {
  it('emits (no items) body + the zero-count label when there are no lines', () => {
    const out = buildPoShareText(
      { storeName: 'Towson', referenceDate: '2026-07-03', lines: [] },
      { ...EN_LABELS, itemsCount: '0 items', noItems: '(no items)' },
      byId({}),
    );
    expect(out).toBe(
      ['I.M.R — Purchase order', 'Store: Towson', 'Date: 2026-07-03', '', '(no items)', '', '0 items'].join('\n'),
    );
  });
});

describe('buildPoShareText — NO money anywhere (AC)', () => {
  it('never contains a $ (cost basis stays private)', () => {
    const out = buildPoShareText(
      {
        storeName: 'Towson',
        referenceDate: '2026-07-03',
        lines: [
          { itemId: 'a', itemName: 'A', orderedQty: 3, unit: 'case' },
          { itemId: 'b', itemName: 'B', orderedQty: 12, unit: 'lb' },
        ],
      },
      { ...EN_LABELS, itemsCount: '2 items' },
      byId({ a: 'Chicken Thigh', b: 'Yellow Onion' }),
    );
    expect(out).not.toContain('$');
  });
});
