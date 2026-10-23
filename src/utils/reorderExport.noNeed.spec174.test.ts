// src/utils/reorderExport.noNeed.spec174.test.ts — Spec 174 (G1, G3).
//
// A reorder row counted NO NEED (flag `no_need`, spec 172 hunk R4) prints the
// NO NEED label in its On Hand cell instead of the stale `current_stock`
// number. Covers the shared admin CSV (`buildReorderCsv`) and the shared
// PDF-HTML (`buildReorderPdfHtml`, English-only) builders.
//
// The byte-identity pins (AC-4 / AC-9) were captured as snapshots on the
// UNMODIFIED builders (`main` at f7b2759) before the spec 174 source edit, so
// a numeric-only payload provably renders byte-for-byte as before. The
// existing `reorderExport.test.ts` suite is deliberately left untouched.

import Papa from 'papaparse';
import type { ReorderItem, ReorderPayload, ReorderVendor } from '../types';
import type { Locale } from '../i18n';
import { t } from '../i18n';
import { buildReorderCsv, buildReorderPdfHtml, reorderNoNeedLabel } from './reorderExport';

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

// Needs-to-order case row (localized name + unit exercised in es / zh-CN).
const WINGS = row({
  itemId: 'i-wings', itemName: 'Wings', unit: 'bags',
  onHand: 4, pendingPoQty: 2, parLevel: 40, parReplacement: 34,
  suggestedQty: 34, caseQty: 10, suggestedCases: 4, suggestedUnits: 40,
  costPerUnit: 2.5, estimatedCost: 100,
  i18nNames: { es: 'Alitas', 'zh-CN': '鸡翅' },
});
// Have-enough numeric row with a fractional on-hand.
const SAUCE = row({
  itemId: 'i-sauce', itemName: 'Sauce', unit: 'gal',
  onHand: 12.5, parLevel: 10, needsOrder: false,
});
// AC-20 — "zero but not NO NEED": every zero signal EXCEPT the flag.
const LEMONS = row({
  itemId: 'i-lemons', itemName: 'Lemons', unit: 'each',
  onHand: 0, parLevel: 0, suggestedQty: 0, needsOrder: false, flags: ['no_par'],
});
// The toggled row: a distinctive on-hand (37) so a leak is greppable.
function napkins(flags: string[]): ReorderItem {
  return row({
    itemId: 'i-napkins', itemName: 'Napkins', unit: 'bags',
    onHand: 37, parLevel: 20, needsOrder: false, flags,
    i18nNames: { es: 'Servilletas', 'zh-CN': '餐巾' },
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

/** Numeric-only payload (no NO NEED row) — the byte-identity fixture. */
const numericPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE]);

describe('Spec 174 — numeric-only output is byte-identical (pre-change pins)', () => {
  it.each(LOCALES)('AC-4 — buildReorderCsv(%s) matches the f7b2759 pin', (locale) => {
    expect(buildReorderCsv(numericPayload(), locale)).toMatchSnapshot(`csv-${locale}`);
  });

  it('AC-9 — buildReorderPdfHtml matches the f7b2759 pin', () => {
    expect(buildReorderPdfHtml(numericPayload(), 'Frederick')).toMatchSnapshot('pdf-html-en');
  });
});

// ─── Flag-toggle differential fixtures ──────────────────────────────────
// The SAME payload with the Napkins row flagged vs unflagged: the outputs may
// differ ONLY in that row's On Hand cell (plus the CSV Flags cell).
const flaggedPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE, napkins(['no_need'])]);
const unflaggedPayload = (): ReorderPayload => payloadOf([WINGS, SAUCE, napkins([])]);

const LABEL: Record<Locale, string> = { en: 'NO NEED', es: 'NO HACE FALTA', 'zh-CN': '无需' };
const NAPKINS_NAME: Record<Locale, string> = { en: 'Napkins', es: 'Servilletas', 'zh-CN': '餐巾' };
const LEMONS_NAME = 'Lemons';

function parseCsv(csv: string): { fields: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  return { fields: parsed.meta.fields ?? [], rows: parsed.data };
}

describe('Spec 174 — reorderNoNeedLabel', () => {
  it.each(LOCALES)('%s resolves to the localized NO NEED label', (locale) => {
    expect(reorderNoNeedLabel(locale)).toBe(LABEL[locale]);
  });

  it('the en literal agrees with the catalog key it shadows', () => {
    expect(reorderNoNeedLabel('en')).toBe(t('en', 'section.reorder.noNeed'));
  });
});

describe('Spec 174 — buildReorderCsv (G1)', () => {
  it.each(LOCALES)('AC-2 — %s: the NO NEED row prints the label in On Hand, not the stale number', (locale) => {
    const { fields, rows } = parseCsv(buildReorderCsv(flaggedPayload(), locale));
    const onHandCol = fields[3];
    const itemCol = fields[2];
    const napkinsRow = rows.find((r) => r[itemCol] === NAPKINS_NAME[locale]);
    expect(napkinsRow).toBeDefined();
    expect(napkinsRow![onHandCol]).toBe(LABEL[locale]);
    expect(napkinsRow![onHandCol]).not.toContain('37');
  });

  it.each(LOCALES)('AC-3 — %s: every other cell matches the unflagged clone; Flags keeps the raw token', (locale) => {
    const flagged = parseCsv(buildReorderCsv(flaggedPayload(), locale));
    const plain = parseCsv(buildReorderCsv(unflaggedPayload(), locale));
    expect(flagged.fields).toEqual(plain.fields);
    const onHandCol = flagged.fields[3];
    const flagsCol = flagged.fields[11];
    const itemCol = flagged.fields[2];
    expect(flagged.rows).toHaveLength(plain.rows.length);
    flagged.rows.forEach((r, i) => {
      const p = plain.rows[i];
      if (r[itemCol] !== NAPKINS_NAME[locale]) {
        // Non-toggled rows are untouched.
        expect(r).toEqual(p);
        return;
      }
      expect(p[onHandCol]).toBe('37');
      expect(r[flagsCol]).toBe('no_need');
      expect(p[flagsCol]).toBe('');
      const { [onHandCol]: _a, [flagsCol]: _b, ...restFlagged } = r;
      const { [onHandCol]: _c, [flagsCol]: _d, ...restPlain } = p;
      expect(restFlagged).toEqual(restPlain);
    });
  });

  it.each(LOCALES)('AC-20 — %s: a zero-but-not-flagged row still prints its number', (locale) => {
    const { fields, rows } = parseCsv(buildReorderCsv(flaggedPayload(), locale));
    const lemons = rows.find((r) => r[fields[2]] === LEMONS_NAME);
    expect(lemons![fields[3]]).toBe('0');
    expect(lemons![fields[11]]).toBe('no_par');
  });
});

/** The text of each `<td>` per `<tr>` (tbody rows only — header rows use `<th>`). */
function tableRows(html: string): string[][] {
  return Array.from(html.matchAll(/<tr>([\s\S]*?)<\/tr>/g))
    .map((m) => Array.from(m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((c) => c[1]))
    .filter((cells) => cells.length > 0);
}

describe('Spec 174 — buildReorderPdfHtml (G3)', () => {
  it('AC-8 — the NO NEED row prints the English label in On Hand; the other six cells are unchanged', () => {
    const flagged = tableRows(buildReorderPdfHtml(flaggedPayload(), 'Frederick'));
    const plain = tableRows(buildReorderPdfHtml(unflaggedPayload(), 'Frederick'));
    const fi = flagged.findIndex((cells) => cells[0] === 'Napkins');
    expect(fi).toBeGreaterThanOrEqual(0);
    expect(flagged[fi][1]).toBe('NO NEED');
    expect(flagged[fi][1]).not.toContain('37');
    expect(plain[fi][1]).toBe('37');
    expect(flagged[fi]).toHaveLength(7);
    [0, 2, 3, 4, 5, 6].forEach((c) => expect(flagged[fi][c]).toBe(plain[fi][c]));
  });

  it('AC-8 — the whole document differs from the unflagged clone in exactly that one cell', () => {
    const a = buildReorderPdfHtml(flaggedPayload(), 'Frederick').split('\n');
    const b = buildReorderPdfHtml(unflaggedPayload(), 'Frederick').split('\n');
    expect(a).toHaveLength(b.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    expect(diff).toEqual([['              <td class="num">NO NEED</td>', '              <td class="num">37</td>']]);
  });

  it('AC-20 — a zero-but-not-flagged row still prints its number', () => {
    const rows = tableRows(buildReorderPdfHtml(flaggedPayload(), 'Frederick'));
    const lemons = rows.find((cells) => cells[0] === LEMONS_NAME);
    expect(lemons![1]).toBe('0');
  });
});
