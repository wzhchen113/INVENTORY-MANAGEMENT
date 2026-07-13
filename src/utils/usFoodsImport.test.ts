// src/utils/usFoodsImport.test.ts
import type { ReorderItem, ReorderPayload, ReorderVendor } from '../types';
import {
  buildUsFoodsImportCsv,
  planUsFoodsExport,
  US_FOODS_IMPORT_COLUMNS,
  type UsFoodsImportHeader,
} from './usFoodsImport';

function caseItem(over: Partial<ReorderItem> = {}): ReorderItem {
  // 16 units, case of 4 → 4 cases, est $354.72.
  return {
    itemId: 'i-1',
    itemName: 'Chicken Leg',
    unit: 'bags',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 16,
    usageForecasted: 0,
    parReplacement: 16,
    suggestedQty: 16,
    costPerUnit: 5,
    estimatedCost: 354.72,
    caseQty: 4,
    suggestedCases: 4,
    suggestedUnits: 16,
    flags: [],
    ...over,
  };
}

function plainItem(over: Partial<ReorderItem> = {}): ReorderItem {
  // No case size → ordered in base units.
  return {
    ...caseItem({
      itemId: 'i-2',
      itemName: 'Fry Oil Canola',
      unit: 'each',
      suggestedQty: 5,
      caseQty: 1,
      suggestedCases: null,
      suggestedUnits: 5,
      estimatedCost: 194.75,
    }),
    ...over,
  };
}

const header: UsFoodsImportHeader = {
  customerNumber: '12345678',
  distributor: '4147',
  department: '0',
  asOfDate: '2026-07-11',
};

describe('buildUsFoodsImportCsv', () => {
  it('emits the exact 19-column template header', () => {
    const { csv } = buildUsFoodsImportCsv([caseItem()], header, () => '8328700');
    const firstLine = csv.split(/\r?\n/)[0];
    expect(firstLine).toBe(US_FOODS_IMPORT_COLUMNS.join(','));
  });

  it('maps a case item: product #, CS = cases, EA = 0, US date, header fields', () => {
    const { csv, included, skippedNoCode } = buildUsFoodsImportCsv([caseItem()], header, () => '8328700');
    expect(included).toBe(1);
    expect(skippedNoCode).toBe(0);
    const row = csv.split(/\r?\n/)[1].split(',');
    // CUSTOMER NUMBER, DISTRIBUTOR, DEPARTMENT, DATE, PO, PRODUCT NUMBER
    expect(row[0]).toBe('12345678');
    expect(row[1]).toBe('4147');
    expect(row[2]).toBe('0');
    expect(row[3]).toBe('7/11/2026');
    expect(row[5]).toBe('8328700');
    expect(row[7]).toBe('Chicken Leg'); // DESCRIPTION
    // CS (index 12) = 4, EA (index 13) = 0
    expect(row[12]).toBe('4');
    expect(row[13]).toBe('0');
    expect(row[14]).toBe('354.72'); // EXTENDED PRICE
  });

  it('maps a no-case item into EA (CS = 0)', () => {
    const { csv } = buildUsFoodsImportCsv([plainItem()], header, () => '3327053');
    const row = csv.split(/\r?\n/)[1].split(',');
    expect(row[5]).toBe('3327053');
    expect(row[12]).toBe('0'); // CS
    expect(row[13]).toBe('5'); // EA
  });

  it('SKIPS items with no order code and counts them', () => {
    const codes: Record<string, string> = { 'i-1': '8328700' }; // i-2 has none
    const { csv, included, skippedNoCode } = buildUsFoodsImportCsv(
      [caseItem(), plainItem()],
      header,
      (it) => codes[it.itemId],
    );
    expect(included).toBe(1);
    expect(skippedNoCode).toBe(1);
    expect(csv).toContain('8328700');
    expect(csv).not.toContain('3327053');
  });

  it('excludes have-enough (at/above par) items from the order file', () => {
    const stocked = caseItem({ itemId: 'i-3', itemName: 'BBQ Sauce', needsOrder: false, suggestedCases: 0, suggestedQty: 0 });
    const { included, skippedNoCode } = buildUsFoodsImportCsv([stocked], header, () => 'zzz');
    expect(included).toBe(0);
    expect(skippedNoCode).toBe(0); // not "skipped for code" — simply not ordered
  });

  it('defaults DEPARTMENT to 0 when blank and renders a header-only file for an empty order', () => {
    const { csv, included } = buildUsFoodsImportCsv([], { ...header, department: '' }, () => 'x');
    expect(included).toBe(0);
    expect(csv.split(/\r?\n/).filter(Boolean)).toHaveLength(1); // header only
  });

  it('neutralizes CSV/spreadsheet formula injection in the product number + description', () => {
    const evil = caseItem({ itemName: '=cmd|calc', itemId: 'i-evil' });
    const { csv } = buildUsFoodsImportCsv([evil], header, () => '=HYPERLINK("http://x")');
    // Leading formula chars are prefixed with a single quote → rendered as text.
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'=cmd|calc");
    // No RAW leading '=' cell survives (would be executed by Excel/Sheets).
    for (const cell of csv.split(/[\r\n,"]+/)) {
      expect(cell.startsWith('=')).toBe(false);
    }
  });
});

// ── planUsFoodsExport: the onCsvPress branch logic (AC4/AC5) ──
function vendorOf(vendorId: string, items: ReorderItem[]): ReorderVendor {
  return {
    vendorId,
    vendorName: vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-07-14',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: null,
    items,
    vendorTotalCost: items.reduce((a, i) => a + i.estimatedCost, 0),
  };
}
function payloadOf(vendors: ReorderVendor[]): ReorderPayload {
  return {
    asOfDate: '2026-07-11',
    vendors,
    kpis: { vendorCount: vendors.length, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
    warnings: [],
  };
}
const CH = 'store-charles';
const TW = 'store-towson';

describe('planUsFoodsExport (onCsvPress branch)', () => {
  it('resolves the per-store customer number (override wins over account_number)', () => {
    const p = payloadOf([vendorOf('v-us', [caseItem()])]);
    const cfg = {
      id: 'v-us',
      accountNumber: 'ACCT-DEFAULT',
      importDistributorNumber: '4147',
      importDepartment: '0',
      importCustomerNumbers: { [CH]: '11111111', [TW]: '22222222' },
    };
    const plan = planUsFoodsExport(p, TW, 'Towson', cfg, () => '8328700');
    expect(plan.included).toBe(1);
    expect(plan.customerNumberMissing).toBe(false);
    expect(plan.filename).toBe('USFoods_ImportOrder_Towson_2026-07-11.csv');
    expect(plan.csv.split(/\r?\n/)[1].split(',')[0]).toBe('22222222'); // Towson's number
  });

  it('falls back to account_number when the store has no override', () => {
    const p = payloadOf([vendorOf('v-us', [caseItem()])]);
    const cfg = { id: 'v-us', accountNumber: 'ACCT-DEFAULT', importCustomerNumbers: { [CH]: '11111111' } };
    const plan = planUsFoodsExport(p, TW, 'Towson', cfg, () => '8328700');
    expect(plan.customerNumberMissing).toBe(false);
    expect(plan.csv.split(/\r?\n/)[1].split(',')[0]).toBe('ACCT-DEFAULT');
  });

  it('flags a missing customer number when neither override nor account_number is set', () => {
    const p = payloadOf([vendorOf('v-us', [caseItem()])]);
    const plan = planUsFoodsExport(p, TW, 'Towson', { id: 'v-us' }, () => '8328700');
    expect(plan.customerNumberMissing).toBe(true);
  });

  it('counts other vendors omitted from the single-vendor file (Risk 1 cue)', () => {
    const p = payloadOf([vendorOf('v-us', [caseItem()]), vendorOf('v-golden', [caseItem()]), vendorOf('v-sysco', [caseItem()])]);
    const plan = planUsFoodsExport(p, CH, 'Charles', { id: 'v-us', accountNumber: 'A' }, () => 'code');
    expect(plan.otherVendorCount).toBe(2);
    expect(plan.included).toBe(1); // only US Foods items in the file
  });
});
