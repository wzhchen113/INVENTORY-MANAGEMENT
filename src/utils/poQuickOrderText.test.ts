// src/utils/poQuickOrderText.test.ts — Spec 114 (D-9 / D-11).
//
// Pins the PURE quick-order builder byte-for-byte: one `<order code>\t<qty>`
// line per PO item (TAB delimiter, in input order), the `??? <name>\t<qty>`
// placeholder for unmapped items + the correct `unmappedCount`, the empty-input
// edge, the injected code/name resolvers, and the hard no-`$` invariant (no
// money ever enters the machine-facing block). Mirrors the discipline of the
// sibling `poShareText.test.ts`.

import {
  buildPoQuickOrderText,
  type PoQuickOrderLine,
  type CodeResolver,
  type NameResolver,
} from './poQuickOrderText';

// A code resolver backed by a fixed map (undefined key → unmapped). The caller's
// real closure over `inventory` + `sel.vendorId` is exercised in POsSection's
// section test; here we inject a plain map.
const codeById = (map: Record<string, string | null | undefined>): CodeResolver =>
  (itemId) => map[itemId];

// A name resolver — returns the mapped display name, else the fallback (the
// plain-English itemName). Same contract as poShareText's NameResolver.
const nameById = (map: Record<string, string>): NameResolver =>
  (itemId, fallbackName) => map[itemId] ?? fallbackName;

const TAB = '\t';

describe('buildPoQuickOrderText — mapped lines (AC-7)', () => {
  it('emits one `<code>\\t<qty>` line per item, in input order, joined by newline', () => {
    const lines: PoQuickOrderLine[] = [
      { itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 },
      { itemId: 'b', itemName: 'Yellow Onion', orderedQty: 12 },
    ];
    const res = buildPoQuickOrderText(lines, codeById({ a: 'US-1001', b: 'US-2002' }), nameById({}));
    expect(res.text).toBe(['US-1001\t3', 'US-2002\t12'].join('\n'));
    expect(res.unmappedCount).toBe(0);
  });

  it('uses a literal TAB (not spaces/comma) between the code and the qty', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'A', orderedQty: 5 }],
      codeById({ a: 'CODE9' }),
      nameById({}),
    );
    expect(res.text).toBe(`CODE9${TAB}5`);
    expect(res.text).toContain(TAB);
    // NOT space-separated, NOT comma-separated.
    expect(res.text).not.toBe('CODE9 5');
    expect(res.text).not.toContain(',');
  });

  it('reuses formatQty (2-decimal, trailing-zero-stripped) for the qty', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'A', orderedQty: 2.5 }],
      codeById({ a: 'X' }),
      nameById({}),
    );
    expect(res.text).toBe(`X${TAB}2.5`);
  });

  it('trims surrounding whitespace on the resolved code before emitting', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'A', orderedQty: 1 }],
      codeById({ a: '  PAD-1  ' }),
      nameById({}),
    );
    expect(res.text).toBe(`PAD-1${TAB}1`);
  });
});

describe('buildPoQuickOrderText — unmapped lines surfaced, never dropped (AC-9)', () => {
  it('renders `??? <resolved name>\\t<qty>` for a null code and counts it', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Mystery Sauce', orderedQty: 4 }],
      codeById({ a: null }),
      nameById({ a: 'Mystery Sauce' }),
    );
    expect(res.text).toBe(`??? Mystery Sauce${TAB}4`);
    expect(res.unmappedCount).toBe(1);
  });

  it('treats an empty-string code and a whitespace-only code as unmapped', () => {
    const res = buildPoQuickOrderText(
      [
        { itemId: 'a', itemName: 'Empty', orderedQty: 1 },
        { itemId: 'b', itemName: 'Spaces', orderedQty: 2 },
      ],
      codeById({ a: '', b: '   ' }),
      nameById({}),
    );
    expect(res.text).toBe([`??? Empty${TAB}1`, `??? Spaces${TAB}2`].join('\n'));
    expect(res.unmappedCount).toBe(2);
  });

  it('treats a MISSING resolver entry (no link at all) as unmapped', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'z', itemName: 'No Link', orderedQty: 7 }],
      codeById({}), // resolver returns undefined
      nameById({}),
    );
    expect(res.text).toBe(`??? No Link${TAB}7`);
    expect(res.unmappedCount).toBe(1);
  });

  it('resolves the placeholder name in the current locale via resolveName (OQ-8)', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 }],
      codeById({ a: null }),
      nameById({ a: '鸡腿肉' }), // zh-CN display name
    );
    expect(res.text).toBe(`??? 鸡腿肉${TAB}3`);
    // The plain-English fallback is NOT emitted when the resolver overrides it.
    expect(res.text).not.toContain('Chicken Thigh');
  });

  it('falls back to itemName when the resolver has no translation', () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'English Only', orderedQty: 2 }],
      codeById({ a: undefined }),
      (_id, fallbackName) => fallbackName,
    );
    expect(res.text).toBe(`??? English Only${TAB}2`);
  });
});

describe('buildPoQuickOrderText — mixed mapped + unmapped (AC-9)', () => {
  it('emits mapped lines as `<code>\\t<qty>`, unmapped as `??? <name>\\t<qty>`, in input order, with the right count', () => {
    const lines: PoQuickOrderLine[] = [
      { itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 },
      { itemId: 'b', itemName: 'Yellow Onion', orderedQty: 12 },
      { itemId: 'c', itemName: 'Fry Oil', orderedQty: 1 },
    ];
    const res = buildPoQuickOrderText(
      lines,
      codeById({ a: 'US-1001', b: null, c: 'US-3003' }),
      nameById({ b: 'Yellow Onion' }),
    );
    expect(res.text).toBe(
      ['US-1001\t3', '??? Yellow Onion\t12', 'US-3003\t1'].join('\n'),
    );
    expect(res.unmappedCount).toBe(1);
  });
});

describe('buildPoQuickOrderText — NO money anywhere (AC-7, spec 108 ruling)', () => {
  it('never contains a $ (cost basis stays private) — mapped and unmapped lines alike', () => {
    const res = buildPoQuickOrderText(
      [
        { itemId: 'a', itemName: 'A', orderedQty: 3 },
        { itemId: 'b', itemName: 'B', orderedQty: 12 },
      ],
      codeById({ a: 'US-1001', b: null }),
      nameById({ b: 'Yellow Onion' }),
    );
    expect(res.text).not.toContain('$');
  });
});

describe('buildPoQuickOrderText — empty input edge (D-9)', () => {
  it('returns { text: "", unmappedCount: 0 } for no lines', () => {
    const res = buildPoQuickOrderText([], codeById({}), nameById({}));
    expect(res).toEqual({ text: '', unmappedCount: 0 });
  });
});
