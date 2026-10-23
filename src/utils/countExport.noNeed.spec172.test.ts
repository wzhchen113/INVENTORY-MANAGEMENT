// src/utils/countExport.noNeed.spec172.test.ts — Spec 172 (AC-39 / OQ-6).
//
// An EOD NO NEED row exports blank Counted Cases / Counted Units and the
// localized NO NEED label in Counted Total (en verbatim; es / zh-CN via
// `section.eod.export.noNeed`). The flag is ignored for `inventoryCount`, and a
// row without the flag is unchanged (the spec 139 suite is unmodified).

import { buildCountCsv, buildCountPdfHtml, type CountExportParams } from './countExport';
import enCatalog from '../i18n/en.json';
import esCatalog from '../i18n/es.json';
import zhCatalog from '../i18n/zh-CN.json';

function params(
  screen: CountExportParams['screen'],
  locale: CountExportParams['locale'],
): CountExportParams {
  return {
    screen,
    locale,
    storeName: 'Frederick',
    dateIso: '2026-10-23',
    groups: [
      {
        label: 'BJs',
        items: [
          {
            name: 'Napkins',
            category: 'Paper',
            unit: 'pack',
            caseQty: 6,
            parLevel: 4,
            countedCases: null,
            countedUnits: null,
            note: 'shelf full',
            noNeed: true,
          },
          {
            name: 'Flour',
            category: 'Dry',
            unit: 'lb',
            caseQty: 12,
            parLevel: 2,
            countedCases: 1,
            countedUnits: 3,
            note: '',
          },
        ],
      },
    ],
  };
}

function cells(csv: string, name: string): Record<string, string> {
  const lines = csv.split(/\r?\n/);
  const header = lines[0].split(',');
  const row = lines.find((l) => l.includes(name))!.split(',');
  return Object.fromEntries(header.map((h, i) => [h, row[i]]));
}

describe('countExport — spec 172 NO NEED (AC-39)', () => {
  it('en: blank case / unit cells, "NO NEED" in Counted Total, note kept', () => {
    const c = cells(buildCountCsv(params('eod', 'en')), 'Napkins');
    expect(c['Counted Cases']).toBe('');
    expect(c['Counted Units']).toBe('');
    expect(c['Counted Total']).toBe('NO NEED');
    expect(c['Note']).toBe('shelf full');
  });

  it('a numeric row in the same export is unchanged', () => {
    const c = cells(buildCountCsv(params('eod', 'en')), 'Flour');
    expect(c['Counted Total']).toBe('15');
  });

  it('es / zh-CN localize the label from section.eod.export.noNeed', () => {
    const es = buildCountCsv(params('eod', 'es'));
    const zh = buildCountCsv(params('eod', 'zh-CN'));
    expect(es).toContain(esCatalog.section.eod.export.noNeed);
    expect(zh).toContain(zhCatalog.section.eod.export.noNeed);
    expect(enCatalog.section.eod.export.noNeed).toBe('NO NEED');
  });

  it('the PDF renders the label in the Counted Total cell', () => {
    const html = buildCountPdfHtml(params('eod', 'en'));
    expect(html).toContain('<td>NO NEED</td>');
  });

  it('inventoryCount ignores the flag (no NO NEED cell)', () => {
    const csv = buildCountCsv(params('inventoryCount', 'en'));
    expect(csv).not.toContain('NO NEED');
  });
});
