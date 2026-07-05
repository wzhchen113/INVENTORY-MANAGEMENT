// src/utils/poQuickOrderText.test.ts — Spec 114 (D-9 / D-11) + Spec 115 (W-2).
//
// Pins the PURE quick-order builder byte-for-byte: one `<order code>\t<qty>`
// line per PO item (TAB delimiter, in input order), the `??? <name>\t<qty>`
// placeholder for unmapped items + the correct `unmappedCount`, the empty-input
// edge, the injected code/name resolvers, and the hard no-`$` invariant (no
// money ever enters the machine-facing block). Mirrors the discipline of the
// sibling `poShareText.test.ts`.
//
// Spec 115 (W-2, AC-14) — the builder is now order-unit aware. Every call takes
// a 4th `orderUnit` arg and the result carries `roundedCount`. The spec-114
// suites below pass `'unit'` (verbatim behavior, byte-for-byte unchanged) so the
// original assertions stand; the NEW suite pins the `'case'` conversion:
// exact division, fractional → ceil + `roundedCount`, `caseQty` null/1 → ÷1,
// `'unit'` verbatim + `roundedCount === 0`, and that no `$` ever appears.

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

// Spec 115 — the spec-114 suites all order in COUNTED UNITS ('unit' vendor), so
// caseQty is irrelevant; default it to 1 on the fixtures to keep the shape total.
const U = (partial: Omit<PoQuickOrderLine, 'caseQty'> & { caseQty?: number }): PoQuickOrderLine => ({
  caseQty: 1,
  ...partial,
});

describe('buildPoQuickOrderText — mapped lines (AC-7), unit vendor verbatim', () => {
  it('emits one `<code>\\t<qty>` line per item, in input order, joined by newline', () => {
    const lines: PoQuickOrderLine[] = [
      U({ itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 }),
      U({ itemId: 'b', itemName: 'Yellow Onion', orderedQty: 12 }),
    ];
    const res = buildPoQuickOrderText(lines, codeById({ a: 'US-1001', b: 'US-2002' }), nameById({}), 'unit');
    expect(res.text).toBe(['US-1001\t3', 'US-2002\t12'].join('\n'));
    expect(res.unmappedCount).toBe(0);
    expect(res.roundedCount).toBe(0);
  });

  it('uses a literal TAB (not spaces/comma) between the code and the qty', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'A', orderedQty: 5 })],
      codeById({ a: 'CODE9' }),
      nameById({}),
      'unit',
    );
    expect(res.text).toBe(`CODE9${TAB}5`);
    expect(res.text).toContain(TAB);
    // NOT space-separated, NOT comma-separated.
    expect(res.text).not.toBe('CODE9 5');
    expect(res.text).not.toContain(',');
  });

  it('reuses formatQty (2-decimal, trailing-zero-stripped) for the qty', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'A', orderedQty: 2.5 })],
      codeById({ a: 'X' }),
      nameById({}),
      'unit',
    );
    expect(res.text).toBe(`X${TAB}2.5`);
  });

  it('trims surrounding whitespace on the resolved code before emitting', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'A', orderedQty: 1 })],
      codeById({ a: '  PAD-1  ' }),
      nameById({}),
      'unit',
    );
    expect(res.text).toBe(`PAD-1${TAB}1`);
  });
});

describe('buildPoQuickOrderText — unmapped lines surfaced, never dropped (AC-9)', () => {
  it('renders `??? <resolved name>\\t<qty>` for a null code and counts it', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'Mystery Sauce', orderedQty: 4 })],
      codeById({ a: null }),
      nameById({ a: 'Mystery Sauce' }),
      'unit',
    );
    expect(res.text).toBe(`??? Mystery Sauce${TAB}4`);
    expect(res.unmappedCount).toBe(1);
  });

  it('treats an empty-string code and a whitespace-only code as unmapped', () => {
    const res = buildPoQuickOrderText(
      [
        U({ itemId: 'a', itemName: 'Empty', orderedQty: 1 }),
        U({ itemId: 'b', itemName: 'Spaces', orderedQty: 2 }),
      ],
      codeById({ a: '', b: '   ' }),
      nameById({}),
      'unit',
    );
    expect(res.text).toBe([`??? Empty${TAB}1`, `??? Spaces${TAB}2`].join('\n'));
    expect(res.unmappedCount).toBe(2);
  });

  it('treats a MISSING resolver entry (no link at all) as unmapped', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'z', itemName: 'No Link', orderedQty: 7 })],
      codeById({}), // resolver returns undefined
      nameById({}),
      'unit',
    );
    expect(res.text).toBe(`??? No Link${TAB}7`);
    expect(res.unmappedCount).toBe(1);
  });

  it('resolves the placeholder name in the current locale via resolveName (OQ-8)', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 })],
      codeById({ a: null }),
      nameById({ a: '鸡腿肉' }), // zh-CN display name
      'unit',
    );
    expect(res.text).toBe(`??? 鸡腿肉${TAB}3`);
    // The plain-English fallback is NOT emitted when the resolver overrides it.
    expect(res.text).not.toContain('Chicken Thigh');
  });

  it('falls back to itemName when the resolver has no translation', () => {
    const res = buildPoQuickOrderText(
      [U({ itemId: 'a', itemName: 'English Only', orderedQty: 2 })],
      codeById({ a: undefined }),
      (_id, fallbackName) => fallbackName,
      'unit',
    );
    expect(res.text).toBe(`??? English Only${TAB}2`);
  });
});

describe('buildPoQuickOrderText — mixed mapped + unmapped (AC-9)', () => {
  it('emits mapped lines as `<code>\\t<qty>`, unmapped as `??? <name>\\t<qty>`, in input order, with the right count', () => {
    const lines: PoQuickOrderLine[] = [
      U({ itemId: 'a', itemName: 'Chicken Thigh', orderedQty: 3 }),
      U({ itemId: 'b', itemName: 'Yellow Onion', orderedQty: 12 }),
      U({ itemId: 'c', itemName: 'Fry Oil', orderedQty: 1 }),
    ];
    const res = buildPoQuickOrderText(
      lines,
      codeById({ a: 'US-1001', b: null, c: 'US-3003' }),
      nameById({ b: 'Yellow Onion' }),
      'unit',
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
        U({ itemId: 'a', itemName: 'A', orderedQty: 3 }),
        U({ itemId: 'b', itemName: 'B', orderedQty: 12 }),
      ],
      codeById({ a: 'US-1001', b: null }),
      nameById({ b: 'Yellow Onion' }),
      'unit',
    );
    expect(res.text).not.toContain('$');
  });
});

describe('buildPoQuickOrderText — empty input edge (D-9)', () => {
  it('returns { text: "", unmappedCount: 0, roundedCount: 0 } for no lines', () => {
    const res = buildPoQuickOrderText([], codeById({}), nameById({}), 'case');
    expect(res).toEqual({ text: '', unmappedCount: 0, roundedCount: 0 });
  });
});

// ─── Spec 115 (W-2, AC-14) — order-unit conversion, byte-for-byte ────────────
//
// THE correctness surface (R-2's raison d'être): a 'case' vendor divides the
// counted-unit qty by coalesce(caseQty,1) and rounds UP to whole cases, fail-loud
// via roundedCount; a 'unit' vendor keeps the counted value verbatim.
describe('buildPoQuickOrderText — order-unit conversion (W-2, AC-14)', () => {
  it("'case' vendor with caseQty=24 & orderedQty=48 emits 2, roundedCount 0 (exact multiple)", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Water', orderedQty: 48, caseQty: 24 }],
      codeById({ a: 'US-1001' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(`US-1001${TAB}2`);
    expect(res.roundedCount).toBe(0);
    expect(res.unmappedCount).toBe(0);
  });

  it("'case' vendor with caseQty=24 & orderedQty=30 emits 2 AND increments roundedCount (30/24 = 1.25 → ceil 2)", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Water', orderedQty: 30, caseQty: 24 }],
      codeById({ a: 'US-1001' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(`US-1001${TAB}2`);
    expect(res.roundedCount).toBe(1);
  });

  it("'case' vendor with caseQty=null (typed as any → coerced) divides by 1 (units == cases), roundedCount 0", () => {
    // ReorderItem.caseQty is `number` (server sends 1 for no-case), but guard the
    // runtime null/0 path explicitly since the coalesce is load-bearing.
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Salt', orderedQty: 7, caseQty: null as unknown as number }],
      codeById({ a: 'US-2002' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(`US-2002${TAB}7`);
    expect(res.roundedCount).toBe(0);
  });

  it("'case' vendor with caseQty=1 divides by 1 (units == cases), roundedCount 0", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Salt', orderedQty: 9, caseQty: 1 }],
      codeById({ a: 'US-2002' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(`US-2002${TAB}9`);
    expect(res.roundedCount).toBe(0);
  });

  it("'case' vendor with caseQty=0 divides by 1 (never divide by 0), roundedCount 0", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Salt', orderedQty: 5, caseQty: 0 }],
      codeById({ a: 'US-2002' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(`US-2002${TAB}5`);
    expect(res.roundedCount).toBe(0);
  });

  it("'unit' vendor emits the counted value unchanged (no division) with roundedCount 0, even with a real caseQty", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Water', orderedQty: 30, caseQty: 24 }],
      codeById({ a: 'US-1001' }),
      nameById({}),
      'unit',
    );
    expect(res.text).toBe(`US-1001${TAB}30`);
    expect(res.roundedCount).toBe(0);
  });

  it("'case' conversion applies to the unmapped `???` line's qty too (still surfaced, converted)", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Mystery', orderedQty: 30, caseQty: 24 }],
      codeById({ a: null }),
      nameById({ a: 'Mystery' }),
      'case',
    );
    expect(res.text).toBe(`??? Mystery${TAB}2`);
    expect(res.unmappedCount).toBe(1);
    expect(res.roundedCount).toBe(1); // 30/24 rounded up even on the unmapped line
  });

  it('counts roundedCount across a MIXED batch (only fractional case lines counted)', () => {
    const res = buildPoQuickOrderText(
      [
        { itemId: 'a', itemName: 'Exact', orderedQty: 48, caseQty: 24 }, // 2.0 → no round
        { itemId: 'b', itemName: 'Frac1', orderedQty: 30, caseQty: 24 }, // 1.25 → round
        { itemId: 'c', itemName: 'NoCase', orderedQty: 5, caseQty: 1 },  // 5.0 → no round
        { itemId: 'd', itemName: 'Frac2', orderedQty: 13, caseQty: 6 },  // 2.16 → round
      ],
      codeById({ a: 'A', b: 'B', c: 'C', d: 'D' }),
      nameById({}),
      'case',
    );
    expect(res.text).toBe(['A\t2', 'B\t2', 'C\t5', 'D\t3'].join('\n'));
    expect(res.roundedCount).toBe(2);
  });

  it("'case' conversion never emits a $ (money stays private)", () => {
    const res = buildPoQuickOrderText(
      [{ itemId: 'a', itemName: 'Water', orderedQty: 30, caseQty: 24 }],
      codeById({ a: 'US-1001' }),
      nameById({}),
      'case',
    );
    expect(res.text).not.toContain('$');
  });
});
