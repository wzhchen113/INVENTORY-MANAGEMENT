// src/screens/cmd/sections/__tests__/ReorderSection.pdfNoNeed.spec174.test.tsx
// Spec 174 (G2) — the admin jsPDF export prints the NO NEED label in the On
// Hand column (index 1) for a row flagged `no_need`, in whichever table the
// row lands (needs or have-enough). zh-CN falls back to the English label, as
// the whole PDF does (no CJK glyph reaches Helvetica).
//
// `handlePdfExport` is called DIRECTLY (no section render). Boundary mocking
// mirrors ReorderSection.resetAfterExport.spec138: web Platform, Toast, the
// store, the theme, and a minimal jsPDF class; `jspdf-autotable` is a jest.fn
// so each table's `head` / `body` is captured.
//
// The numeric-only `head` / `body` pins (AC-7) were captured as snapshots on
// the UNMODIFIED `handlePdfExport` (`main` at f7b2759) before the spec 174
// source edit.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {};
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn };
});

// Every string handed to `doc.text` — the AC-6 no-CJK probe reads it.
const mockDocText: string[] = [];
jest.mock('jspdf', () => ({
  __esModule: true,
  default: class {
    internal = { pageSize: { getHeight: () => 800 } };
    lastAutoTable = { finalY: 120 };
    setFont() { return this; }
    setFontSize() { return this; }
    setTextColor() { return this; }
    text(s: string) { mockDocText.push(String(s)); return this; }
    getTextWidth() { return 10; }
    addPage() { return this; }
    save() { return this; }
  },
}));
jest.mock('jspdf-autotable', () => ({ __esModule: true, default: jest.fn() }));

import autoTable from 'jspdf-autotable';
import type { ReorderItem, ReorderPayload, ReorderVendor, Store } from '../../../../types';
import type { Locale } from '../../../../i18n';
import { handlePdfExport } from '../ReorderSection';

const autoTableMock = autoTable as unknown as jest.Mock;

type Captured = { head: string[][]; body: string[][] };

function row(over: Partial<ReorderItem>): ReorderItem {
  return {
    itemId: 'i-x',
    itemName: 'Item',
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 0,
    usageForecasted: 0,
    parReplacement: 0,
    suggestedQty: 0,
    costPerUnit: 1,
    estimatedCost: 0,
    caseQty: 1,
    suggestedCases: null,
    suggestedUnits: 0,
    flags: [],
    ...over,
  };
}

const WINGS = row({
  itemId: 'i-wings', itemName: 'Wings', unit: 'bags',
  onHand: 4, pendingPoQty: 2, parLevel: 40, parReplacement: 34,
  suggestedQty: 34, caseQty: 10, suggestedCases: 4, suggestedUnits: 40,
  costPerUnit: 2.5, estimatedCost: 100,
  i18nNames: { es: 'Alitas', 'zh-CN': '鸡翅' },
});
const SAUCE = row({
  itemId: 'i-sauce', itemName: 'Sauce', unit: 'gal',
  onHand: 12.5, parLevel: 10, needsOrder: false,
});
// AC-20 — "zero but not NO NEED".
const LEMONS = row({
  itemId: 'i-lemons', itemName: 'Lemons', unit: 'each',
  onHand: 0, parLevel: 0, suggestedQty: 0, needsOrder: false, flags: ['no_par'],
});

function vendor(over: Partial<ReorderVendor>, items: ReorderItem[]): ReorderVendor {
  return {
    vendorId: 'v-1',
    vendorName: 'US Foods',
    scheduleKnown: true,
    nextDeliveryDate: '2026-10-24',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: '2026-10-23T02:00:00Z',
    items,
    vendorTotalCost: items.reduce((a, i) => a + i.estimatedCost, 0),
    ...over,
  };
}

function payloadOf(v1Items: ReorderItem[]): ReorderPayload {
  const vendors = [
    vendor({}, v1Items),
    vendor(
      { vendorId: 'v-2', vendorName: 'Sysco', onHandSource: 'stock', eodSubmittedAt: null, daysUntilNextDelivery: 3 },
      [LEMONS],
    ),
  ];
  return {
    asOfDate: '2026-10-23',
    vendors,
    kpis: {
      vendorCount: 2,
      itemCount: 1,
      totalEstimatedCost: 100,
      eodSourcedVendorCount: 1,
      stockFallbackVendorCount: 1,
    },
    warnings: [],
  };
}

const STORE = { id: 'store-1', name: 'Frederick' } as Store;

/** Run the export and return every autoTable call's head/body, in order. */
async function capture(payload: ReorderPayload, locale: Locale): Promise<{ ok: boolean; tables: Captured[] }> {
  autoTableMock.mockClear();
  mockDocText.length = 0;
  const ok = await handlePdfExport(payload, STORE, locale);
  const tables = autoTableMock.mock.calls.map((c) => {
    const opts = c[1] as Captured;
    return { head: opts.head, body: opts.body };
  });
  return { ok, tables };
}

const numericPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE]);

// The toggled row: a distinctive on-hand (37) so a leak is greppable.
function napkins(flags: string[], over: Partial<ReorderItem> = {}): ReorderItem {
  return row({
    itemId: 'i-napkins', itemName: 'Napkins', unit: 'bags',
    onHand: 37, parLevel: 20, needsOrder: false, flags,
    i18nNames: { es: 'Servilletas', 'zh-CN': '餐巾' },
    ...over,
  });
}

describe('Spec 174 — admin jsPDF numeric-only head/body (pre-change pins)', () => {
  it.each<Locale>(['en', 'es'])('AC-7 — %s head/body match the f7b2759 pin', async (locale) => {
    const { ok, tables } = await capture(numericPayload(), locale);
    expect(ok).toBe(true);
    expect(tables).toMatchSnapshot(`tables-${locale}`);
  });
});

const CJK = /[㐀-鿿]/;

/** Locate the toggled row across every captured table. */
function findRow(tables: Captured[], name: string): { t: number; r: number } | null {
  for (let t = 0; t < tables.length; t++) {
    const r = tables[t].body.findIndex((cells) => cells[0] === name);
    if (r >= 0) return { t, r };
  }
  return null;
}

describe('Spec 174 — admin jsPDF On Hand cell (G2)', () => {
  const cases: Array<[Locale, string, string]> = [
    ['en', 'NO NEED', 'Napkins'],
    ['es', 'NO HACE FALTA', 'Servilletas'],
    // AC-6 — zh-CN is coerced to en for the whole PDF, label included.
    ['zh-CN', 'NO NEED', 'Napkins'],
  ];

  it.each(cases)('AC-5 — %s: have-enough table prints %s; other cells match the unflagged run', async (locale, label, name) => {
    const flagged = await capture(payloadOf([WINGS, SAUCE, napkins(['no_need'])]), locale);
    const plain = await capture(payloadOf([WINGS, SAUCE, napkins([])]), locale);
    expect(flagged.ok).toBe(true);
    const at = findRow(flagged.tables, name);
    expect(at).not.toBeNull();
    const cells = flagged.tables[at!.t].body[at!.r];
    const plainCells = plain.tables[at!.t].body[at!.r];
    // Have-enough table: 7 columns (keeps Unit).
    expect(flagged.tables[at!.t].head[0]).toHaveLength(7);
    expect(cells[1]).toBe(label);
    expect(plainCells[1]).toBe('37');
    [0, 2, 3, 4, 5, 6].forEach((c) => expect(cells[c]).toBe(plainCells[c]));
    // Every other table / row is unchanged.
    expect(flagged.tables.map((tb) => tb.head)).toEqual(plain.tables.map((tb) => tb.head));
    flagged.tables.forEach((tb, ti) =>
      tb.body.forEach((rowCells, ri) => {
        if (ti === at!.t && ri === at!.r) return;
        expect(rowCells).toEqual(plain.tables[ti].body[ri]);
      }),
    );
  });

  it.each(cases)('AC-5 — %s: needs table prints %s for a flagged needs-table row', async (locale, label, name) => {
    // `needsOrder` unset + the flag: never emitted by the RPC; proves the
    // needs-table body site too.
    const odd = (flags: string[]) =>
      napkins(flags, { needsOrder: undefined, suggestedQty: 5, suggestedUnits: 5, estimatedCost: 5 });
    const flagged = await capture(payloadOf([WINGS, odd(['no_need'])]), locale);
    const plain = await capture(payloadOf([WINGS, odd([])]), locale);
    const at = findRow(flagged.tables, name);
    expect(at).not.toBeNull();
    // Needs table: 6 columns (no Unit).
    expect(flagged.tables[at!.t].head[0]).toHaveLength(6);
    const cells = flagged.tables[at!.t].body[at!.r];
    const plainCells = plain.tables[at!.t].body[at!.r];
    expect(cells[1]).toBe(label);
    expect(plainCells[1]).toBe('37');
    [0, 2, 3, 4, 5].forEach((c) => expect(cells[c]).toBe(plainCells[c]));
  });

  it('AC-6 — zh-CN passes no CJK glyph to jsPDF (body cells or doc.text)', async () => {
    const { ok, tables } = await capture(payloadOf([WINGS, SAUCE, napkins(['no_need'])]), 'zh-CN');
    expect(ok).toBe(true);
    tables.forEach((tb) => {
      tb.head.flat().forEach((cell) => expect(cell).not.toMatch(CJK));
      tb.body.flat().forEach((cell) => expect(cell).not.toMatch(CJK));
    });
    expect(mockDocText.length).toBeGreaterThan(0);
    mockDocText.forEach((s) => expect(s).not.toMatch(CJK));
  });

  it('AC-20 — a zero-but-not-flagged row still prints its number', async () => {
    const { tables } = await capture(payloadOf([WINGS, SAUCE, napkins(['no_need'])]), 'en');
    const at = findRow(tables, 'Lemons');
    expect(tables[at!.t].body[at!.r][1]).toBe('0');
  });
});
