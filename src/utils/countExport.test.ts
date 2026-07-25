// src/utils/countExport.test.ts — Spec 139.
//
// Unit coverage for the PURE count-export builders (buildCountCsv,
// buildCountPdfHtml, countExportFilename) across BOTH column sets
// (`eod`, `inventoryCount`), plus the additive UTF-8 BOM at the
// `downloadCSV` download seam. Mirrors the reorderExport.test.ts posture:
// theme-free, no store, node-env project.

import {
  buildCountCsv,
  buildCountPdfHtml,
  countExportFilename,
  type CountExportGroup,
  type CountExportItem,
  type CountExportParams,
} from './countExport';
import { downloadCSV } from './index';

function item(over: Partial<CountExportItem>): CountExportItem {
  return {
    name: over.name ?? 'Item',
    i18nNames: over.i18nNames ?? null,
    category: over.category ?? 'Misc',
    unit: over.unit ?? 'each',
    caseQty: over.caseQty ?? 1,
    parLevel: over.parLevel ?? 0,
    currentStock: over.currentStock,
    countedCases: over.countedCases,
    countedUnits: over.countedUnits,
    note: over.note,
  };
}

// A representative EOD fixture: one vendor group with a case-packed,
// zh-translated, counted item + a plain, untyped (blank) item.
function eodParams(locale: CountExportParams['locale']): CountExportParams {
  const groups: CountExportGroup[] = [
    {
      label: 'BJs',
      items: [
        item({
          name: 'Chicken Leg',
          i18nNames: { 'zh-CN': '鸡腿' },
          category: 'Protein',
          unit: 'bags',
          caseQty: 4,
          parLevel: 10,
          countedCases: 2,
          countedUnits: 3,
          note: 'fresh',
        }),
        item({
          name: 'Olive Oil',
          category: 'Pantry',
          unit: 'gal',
          caseQty: 1,
          parLevel: 5,
          countedCases: null,
          countedUnits: null,
        }),
      ],
    },
  ];
  return { screen: 'eod', groups, storeName: 'Towson Store #2', dateIso: '2026-07-24', locale };
}

function invParams(locale: CountExportParams['locale']): CountExportParams {
  const groups: CountExportGroup[] = [
    {
      label: 'Protein',
      items: [
        item({
          name: 'Chicken Leg',
          i18nNames: { 'zh-CN': '鸡腿' },
          category: 'Protein',
          unit: 'bags',
          caseQty: 4,
          parLevel: 10,
          currentStock: 7,
          countedCases: 2,
          countedUnits: 3,
          note: 'fresh',
        }),
      ],
    },
  ];
  return { screen: 'inventoryCount', groups, storeName: 'Towson Store #2', dateIso: '2026-07-24', locale };
}

const lines = (csv: string) => csv.split(/\r?\n/);

describe('buildCountCsv — column set + order', () => {
  it('EOD header row is the exact English literal set in order (no System On-Hand)', () => {
    const header = lines(buildCountCsv(eodParams('en')))[0];
    expect(header).toBe(
      'Vendor,Category,Item Name,Unit,Case Size,Par Level,Counted Cases,Counted Units,Counted Total,Note',
    );
    expect(header).not.toContain('System On-Hand');
  });

  it('Inventory header row includes System On-Hand and is grouped by Category', () => {
    const header = lines(buildCountCsv(invParams('en')))[0];
    expect(header).toBe(
      'Category,Item Name,Unit,Case Size,Par Level,System On-Hand,Counted Cases,Counted Units,Counted Total,Note',
    );
  });

  it('EOD row: Counted Total = cases*caseQty + units; Case Size shown; note carried', () => {
    const row = lines(buildCountCsv(eodParams('en')))[1].split(',');
    // Vendor,Category,Item Name,Unit,Case Size,Par Level,Cases,Units,Total,Note
    expect(row).toEqual(['BJs', 'Protein', 'Chicken Leg', 'bags', '4', '10', '2', '3', '11', 'fresh']);
  });

  it('untyped row: Case Size blank when caseQty <= 1, counts + total blank', () => {
    const row = lines(buildCountCsv(eodParams('en')))[2].split(',');
    // Olive Oil: caseQty 1 → blank Case Size; no entries → blank Cases/Units/Total/Note
    expect(row).toEqual(['BJs', 'Pantry', 'Olive Oil', 'gal', '', '5', '', '', '', '']);
  });

  it('Inventory row surfaces System On-Hand (currentStock)', () => {
    const row = lines(buildCountCsv(invParams('en')))[1].split(',');
    // Category,Item Name,Unit,Case Size,Par Level,SystemOnHand,Cases,Units,Total,Note
    expect(row).toEqual(['Protein', 'Chicken Leg', 'bags', '4', '10', '7', '2', '3', '11', 'fresh']);
  });
});

describe('buildCountCsv — en identity + BOM-free', () => {
  it('en output is a stable plain-English snapshot (identity contract)', () => {
    expect(buildCountCsv(eodParams('en'))).toMatchSnapshot('eod-en');
    expect(buildCountCsv(invParams('en'))).toMatchSnapshot('inventory-en');
  });

  it('the builder returns BOM-free CSV (the BOM is added at the download seam)', () => {
    const csv = buildCountCsv(eodParams('zh-CN'));
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('buildCountCsv — localized headers + names + units', () => {
  it('zh-CN translates headers, unit token, and the item name via i18nNames', () => {
    const csv = buildCountCsv(eodParams('zh-CN'));
    expect(csv).toContain('供应商'); // Vendor header
    expect(csv).toContain('已数总计'); // Counted Total header
    expect(csv).toContain('鸡腿'); // localized item name
    expect(csv).toContain('袋'); // localized unit (bags → 袋)
    // English header literals must NOT survive on the localized path.
    expect(csv).not.toContain('Counted Total');
    expect(csv).not.toContain('Item Name');
  });

  it('es translates headers + unit; en headers stay literal', () => {
    const es = buildCountCsv(eodParams('es'));
    expect(es).toContain('Proveedor'); // Vendor
    expect(es).toContain('Total contado'); // Counted Total
    expect(es).toContain('bolsas'); // bags → bolsas
    const en = buildCountCsv(eodParams('en'));
    expect(en).toContain('Vendor');
    expect(en).toContain('bags');
  });

  it('item name silently falls back to English when the locale override is absent', () => {
    // Olive Oil has no zh-CN override → English canonical, no (en)/[untranslated].
    const csv = buildCountCsv(eodParams('zh-CN'));
    expect(csv).toContain('Olive Oil');
    expect(csv).not.toContain('[untranslated]');
    expect(csv).not.toContain('(en)');
  });
});

describe('buildCountPdfHtml', () => {
  it('carries a UTF-8 meta tag and a CJK-safe font-family stack (no font embedding)', () => {
    const html = buildCountPdfHtml(eodParams('zh-CN'));
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('PingFang SC');
    expect(html).toContain('Noto Sans SC');
  });

  it('renders localized headers, group labels, and item names under zh-CN', () => {
    const html = buildCountPdfHtml(eodParams('zh-CN'));
    expect(html).toContain('鸡腿'); // localized name
    expect(html).toContain('BJs'); // group label value
    expect(html).toContain('已数总计'); // Counted Total header
  });

  it('escapes HTML-unsafe characters in names + group labels', () => {
    const params: CountExportParams = {
      screen: 'eod',
      groups: [{ label: 'Acme "Foods" & Co', items: [item({ name: 'Salt & <Pepper>' })] }],
      storeName: 'Store & Co',
      dateIso: '2026-07-24',
      locale: 'en',
    };
    const html = buildCountPdfHtml(params);
    expect(html).toContain('Salt &amp; &lt;Pepper&gt;');
    expect(html).toContain('Acme &quot;Foods&quot; &amp; Co');
    expect(html).not.toContain('Salt & <Pepper>');
  });

  it('renders a no-items placeholder for an empty export', () => {
    const params: CountExportParams = {
      screen: 'inventoryCount',
      groups: [],
      storeName: 'Towson',
      dateIso: '2026-07-24',
      locale: 'en',
    };
    expect(buildCountPdfHtml(params)).toContain('(no items)');
  });
});

describe('countExportFilename', () => {
  it('encodes screen + slugified store + date + locale token + extension', () => {
    expect(countExportFilename('eod', 'Towson Store #2', '2026-07-24', 'zh-CN', 'csv')).toBe(
      'IMR_EOD_Count_Towson_Store_2_2026-07-24_zh-CN.csv',
    );
    expect(countExportFilename('inventoryCount', 'Towson Store #2', '2026-07-24', 'en', 'pdf')).toBe(
      'IMR_Inventory_Count_Towson_Store_2_2026-07-24_en.pdf',
    );
  });
});

describe('downloadCSV — additive UTF-8 BOM (spec 139)', () => {
  const realDoc = (global as any).document;
  const realBlob = (global as any).Blob;
  const realCreate = (global as any).URL.createObjectURL;
  const realRevoke = (global as any).URL.revokeObjectURL;

  afterEach(() => {
    (global as any).document = realDoc;
    (global as any).Blob = realBlob;
    (global as any).URL.createObjectURL = realCreate;
    (global as any).URL.revokeObjectURL = realRevoke;
  });

  it('prepends the UTF-8 BOM (\\uFEFF) to the blob content without altering columns', () => {
    // Inspect the raw string handed to the Blob constructor — reading it back
    // via Blob.text() would silently strip the leading BOM (TextDecoder's
    // default), masking the exact byte this test guards.
    const parts: unknown[][] = [];
    (global as any).Blob = function FakeBlob(arr: unknown[]) {
      parts.push(arr);
      return { arr };
    };
    (global as any).URL.createObjectURL = () => 'blob:mock';
    (global as any).URL.revokeObjectURL = () => {};
    (global as any).document = { createElement: () => ({ click: () => {} }) };

    downloadCSV('count.csv', 'a,b\n1,2');
    expect(parts).toHaveLength(1);
    const content = parts[0][0] as string;
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content).toBe('﻿a,b\n1,2');
  });
});
