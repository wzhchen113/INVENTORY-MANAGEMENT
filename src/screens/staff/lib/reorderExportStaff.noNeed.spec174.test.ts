// src/screens/staff/lib/reorderExportStaff.noNeed.spec174.test.ts — Spec 174 (G4).
//
// A reorder row counted NO NEED (flag `no_need`, spec 172 hunk R4) prints the
// localized NO NEED label instead of the stale on-hand figure in all three
// staff builders: CSV (G4a), share text (G4b), and PDF-HTML (G4c).
//
// The byte-identity pins (AC-10 / AC-11 / AC-12) were captured as snapshots on
// the UNMODIFIED builders (`main` at f7b2759) before the spec 174 source edit.
// The existing `reorderExportStaff.test.ts` suite is left untouched (AC-13).

import type { ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';
import Papa from 'papaparse';
import type { Locale } from '../../../i18n';
import {
  buildStaffReorderCsv,
  buildStaffReorderPdfHtml,
  buildStaffReorderText,
} from './reorderExportStaff';

const LOCALES: Locale[] = ['en', 'es', 'zh-CN'];

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
function napkins(flags: string[], over: Partial<ReorderItem> = {}): ReorderItem {
  return row({
    itemId: 'i-napkins', itemName: 'Napkins', unit: 'bags',
    onHand: 37, parLevel: 20, needsOrder: false, flags,
    i18nNames: { es: 'Servilletas', 'zh-CN': '餐巾' },
    ...over,
  });
}

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

const numericPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE]);

describe('Spec 174 — staff numeric-only output is byte-identical (pre-change pins)', () => {
  it.each(LOCALES)('AC-10 — buildStaffReorderCsv(%s) matches the f7b2759 pin', (locale) => {
    expect(buildStaffReorderCsv(numericPayload(), locale)).toMatchSnapshot(`csv-${locale}`);
  });

  it.each(LOCALES)('AC-11 — buildStaffReorderText(%s) matches the f7b2759 pin', (locale) => {
    expect(buildStaffReorderText(numericPayload(), 'Frederick', locale)).toMatchSnapshot(`text-${locale}`);
  });

  it.each(LOCALES)('AC-12 — buildStaffReorderPdfHtml(%s) matches the f7b2759 pin', (locale) => {
    expect(buildStaffReorderPdfHtml(numericPayload(), 'Frederick', locale)).toMatchSnapshot(`pdf-html-${locale}`);
  });
});

// ─── Flag-toggle differential fixtures ──────────────────────────────────
const flaggedPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE, napkins(['no_need'])]);
const unflaggedPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE, napkins([])]);

const LABEL: Record<Locale, string> = { en: 'NO NEED', es: 'NO HACE FALTA', 'zh-CN': '无需' };
const NAPKINS_NAME: Record<Locale, string> = { en: 'Napkins', es: 'Servilletas', 'zh-CN': '餐巾' };
const ON_HAND_PHRASE = /on hand|en existencia|现有/;

function parseCsv(csv: string): { fields: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  return { fields: parsed.meta.fields ?? [], rows: parsed.data };
}

describe('Spec 174 — buildStaffReorderCsv (G4a)', () => {
  it.each(LOCALES)('AC-10 — %s: On Hand is the label; every other cell matches the unflagged clone', (locale) => {
    const flagged = parseCsv(buildStaffReorderCsv(flaggedPayload(), locale));
    const plain = parseCsv(buildStaffReorderCsv(unflaggedPayload(), locale));
    expect(flagged.fields).toEqual(plain.fields);
    const itemCol = flagged.fields[2];
    const onHandCol = flagged.fields[3];
    const flagsCol = flagged.fields[10];
    expect(flagged.rows).toHaveLength(plain.rows.length);
    let seen = false;
    flagged.rows.forEach((r, i) => {
      const p = plain.rows[i];
      if (r[itemCol] !== NAPKINS_NAME[locale]) {
        expect(r).toEqual(p);
        return;
      }
      seen = true;
      expect(r[onHandCol]).toBe(LABEL[locale]);
      expect(r[onHandCol]).not.toContain('37');
      expect(p[onHandCol]).toBe('37');
      expect(r[flagsCol]).toBe('no_need');
      const { [onHandCol]: _a, [flagsCol]: _b, ...restFlagged } = r;
      const { [onHandCol]: _c, [flagsCol]: _d, ...restPlain } = p;
      expect(restFlagged).toEqual(restPlain);
    });
    expect(seen).toBe(true);
  });

  it.each(LOCALES)('AC-20 — %s: a zero-but-not-flagged row still prints its number', (locale) => {
    const { fields, rows } = parseCsv(buildStaffReorderCsv(flaggedPayload(), locale));
    const lemons = rows.find((r) => r[fields[2]] === 'Lemons');
    expect(lemons![fields[3]]).toBe('0');
  });
});

describe('Spec 174 — buildStaffReorderText (G4b)', () => {
  it.each(LOCALES)('AC-11 — %s: the NO NEED line is `{name}: {label}` with no on-hand or unit', (locale) => {
    const lines = buildStaffReorderText(flaggedPayload(), 'Frederick', locale).split('\n');
    const line = lines.find((l) => l.startsWith(`  - ${NAPKINS_NAME[locale]}:`));
    expect(line).toBe(`  - ${NAPKINS_NAME[locale]}: ${LABEL[locale]}`);
    expect(line).not.toMatch(ON_HAND_PHRASE);
    expect(line).not.toContain('37');
  });

  it('AC-11 — en keeps the pre-existing item.itemName on the NO NEED line', () => {
    const text = buildStaffReorderText(flaggedPayload(), 'Frederick', 'en');
    expect(text.split('\n')).toContain('  - Napkins: NO NEED');
  });

  it.each(LOCALES)('AC-11 — %s: every other line (headers, needs section, footer) is unchanged', (locale) => {
    const a = buildStaffReorderText(flaggedPayload(), 'Frederick', locale).split('\n');
    const b = buildStaffReorderText(unflaggedPayload(), 'Frederick', locale).split('\n');
    expect(a).toHaveLength(b.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    expect(diff).toHaveLength(1);
    expect(diff[0][0]).toBe(`  - ${NAPKINS_NAME[locale]}: ${LABEL[locale]}`);
    // The unflagged clone printed the on-hand phrase with 37.
    expect(diff[0][1]).toMatch(ON_HAND_PHRASE);
    expect(diff[0][1]).toContain('37');
  });

  it.each(LOCALES)('AC-20 — %s: a zero-but-not-flagged row keeps its on-hand line', (locale) => {
    const lines = buildStaffReorderText(flaggedPayload(), 'Frederick', locale).split('\n');
    const lemons = lines.find((l) => l.startsWith('  - Lemons:'));
    expect(lemons).toMatch(ON_HAND_PHRASE);
    expect(lemons).toMatch(/ 0 /);
  });
});

/** Each `<td>` text per tbody `<tr>`, tagged with its section box class. */
function boxRows(html: string, cls: 'needs' | 'enough'): string[][] {
  const tables = Array.from(html.matchAll(new RegExp(`<table class="${cls}">([\\s\\S]*?)</table>`, 'g')));
  return tables.flatMap((tbl) =>
    Array.from(tbl[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g))
      .map((m) => Array.from(m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((c) => c[1]))
      .filter((cells) => cells.length > 0),
  );
}

describe('Spec 174 — buildStaffReorderPdfHtml (G4c)', () => {
  it.each(LOCALES)('AC-12 — %s: enough box — On Hand is the label; other cells unchanged', (locale) => {
    const flagged = boxRows(buildStaffReorderPdfHtml(flaggedPayload(), 'Frederick', locale), 'enough');
    const plain = boxRows(buildStaffReorderPdfHtml(unflaggedPayload(), 'Frederick', locale), 'enough');
    const fi = flagged.findIndex((cells) => cells[0] === NAPKINS_NAME[locale]);
    expect(fi).toBeGreaterThanOrEqual(0);
    expect(flagged[fi][1]).toBe(LABEL[locale]);
    expect(plain[fi][1]).toBe('37');
    // Item, Pending, Par, Suggested, Unit (enough box keeps the Unit column).
    expect(flagged[fi]).toHaveLength(6);
    [0, 2, 3, 4, 5].forEach((c) => expect(flagged[fi][c]).toBe(plain[fi][c]));
  });

  it.each(LOCALES)('AC-12 — %s: the document differs from the unflagged clone in exactly that cell', (locale) => {
    const a = buildStaffReorderPdfHtml(flaggedPayload(), 'Frederick', locale).split('\n');
    const b = buildStaffReorderPdfHtml(unflaggedPayload(), 'Frederick', locale).split('\n');
    expect(a).toHaveLength(b.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    expect(diff).toEqual([[`            <td class="num">${LABEL[locale]}</td>`, '            <td class="num">37</td>']]);
  });

  it.each(LOCALES)('AC-12 — %s: the shared vendorBlock site also covers a needs-box placement', (locale) => {
    // `needsOrder` unset + the flag: a combination the RPC never emits; it
    // exists only to prove the ONE shared `vendorBlock` cell covers both boxes.
    const odd = napkins(['no_need'], { needsOrder: undefined, suggestedQty: 5, suggestedUnits: 5, estimatedCost: 5 });
    const html = buildStaffReorderPdfHtml(payloadOf([WINGS, odd]), 'Frederick', locale);
    const needs = boxRows(html, 'needs');
    const row = needs.find((cells) => cells[0] === NAPKINS_NAME[locale]);
    expect(row).toBeDefined();
    expect(row![1]).toBe(LABEL[locale]);
    expect(row).toHaveLength(5);
  });

  it.each(LOCALES)('AC-20 — %s: a zero-but-not-flagged row still prints its number', (locale) => {
    const rows = boxRows(buildStaffReorderPdfHtml(flaggedPayload(), 'Frederick', locale), 'enough');
    const lemons = rows.find((cells) => cells[0] === 'Lemons');
    expect(lemons![1]).toBe('0');
  });
});
