// src/utils/syscoImport.test.ts
import type { ReorderItem, ReorderPayload, ReorderVendor } from '../types';
import {
  buildSyscoImportCsv,
  planSyscoExport,
  type SyscoImportHeader,
} from './syscoImport';

function caseItem(over: Partial<ReorderItem> = {}): ReorderItem {
  return {
    itemId: 'i-1',
    itemName: 'Rice Parboiled Perfect',
    unit: 'bags',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 4,
    usageForecasted: 0,
    parReplacement: 4,
    suggestedQty: 4,
    costPerUnit: 5,
    estimatedCost: 100,
    caseQty: 2,
    suggestedCases: 2,
    suggestedUnits: 4,
    flags: [],
    ...over,
  };
}
function plainItem(over: Partial<ReorderItem> = {}): ReorderItem {
  return caseItem({ itemId: 'i-2', itemName: 'Loose Item', unit: 'each', suggestedQty: 3, caseQty: 1, suggestedCases: null, suggestedUnits: 3, estimatedCost: 30, ...over });
}

const header: SyscoImportHeader = { customerNumber: '239415', asOfDate: '2026-07-06' };

describe('buildSyscoImportCsv', () => {
  it('emits H + F records with the SYSCO field names and the store customer #', () => {
    const { csv } = buildSyscoImportCsv([], header, () => 'x');
    const lines = csv.split('\r\n');
    expect(lines[0].startsWith('H,')).toBe(true);
    expect(lines[0].split(',')[3]).toBe('239415'); // customer # in H position 4
    expect(lines[0]).toContain('"Jul 06, 2026"'); // order datetime
    expect(lines[1]).toBe('F,SUPC,"Case Qty","Split Qty","Cust #",Pack/Size,Brand,Description,"Mfr #","Per Lb","Case $","Each $"');
    expect(lines).toHaveLength(2); // header-only for an empty order
  });

  it('writes a P row: SUPC, Case Qty = cases, Split Qty = 0, quoted description', () => {
    const { csv, included, skippedNoCode } = buildSyscoImportCsv([caseItem()], header, () => '4671368');
    expect(included).toBe(1);
    expect(skippedNoCode).toBe(0);
    const p = csv.split('\r\n')[2].split(',');
    expect(p[0]).toBe('P');
    expect(p[1]).toBe('4671368'); // SUPC
    expect(p[2]).toBe('2'); // Case Qty
    expect(p[3]).toBe('0'); // Split Qty
    expect(csv).toContain('"Rice Parboiled Perfect"'); // quoted (has spaces)
  });

  it('a no-case item goes to Split Qty (Case Qty 0)', () => {
    const { csv } = buildSyscoImportCsv([plainItem()], header, () => '9999999');
    const p = csv.split('\r\n')[2].split(',');
    expect(p[2]).toBe('0'); // Case Qty
    expect(p[3]).toBe('3'); // Split Qty
  });

  it('skips items with no SUPC and counts them; excludes have-enough rows', () => {
    const stocked = caseItem({ itemId: 'i-3', needsOrder: false, suggestedCases: 0, suggestedQty: 0 });
    const codes: Record<string, string> = { 'i-1': '4671368' };
    const { included, skippedNoCode } = buildSyscoImportCsv([caseItem(), plainItem(), stocked], header, (it) => codes[it.itemId]);
    expect(included).toBe(1); // only the coded case item
    expect(skippedNoCode).toBe(1); // plainItem has no code
  });

  it('preserves a leading-zero SUPC and neutralizes formula injection', () => {
    const evil = caseItem({ itemName: '=SUM(A1)' });
    const { csv } = buildSyscoImportCsv([evil], header, () => '0924647');
    expect(csv).toContain('0924647'); // leading zero intact (text, no space → unquoted)
    expect(csv).toContain("'=SUM(A1)"); // formula neutralized (then quoted for the space)
  });

  it('quotes a value containing a bare CR so it cannot split its record row', () => {
    // A staff-writable order code carrying a lone \r must NOT terminate the row
    // (rows join with CRLF). It should be quoted (and the leading \r also
    // csvSafe-prefixed) so no spurious "P," fragment appears.
    const { csv } = buildSyscoImportCsv([caseItem({ itemName: 'Ok' })], header, () => '4671368\rP,evil');
    const dataRows = csv.split('\r\n').filter((l) => l.startsWith('P,'));
    expect(dataRows).toHaveLength(1); // exactly one P record, not split into two
    expect(csv).toContain('"'); // the CR-bearing field is quoted
  });

  it('doubles embedded quotes per RFC 4180', () => {
    const { csv } = buildSyscoImportCsv([caseItem({ itemName: 'A "B" C' })], header, () => '123');
    expect(csv).toContain('"A ""B"" C"');
  });
});

// ── planSyscoExport (onCsvPress branch) ──
function vendorOf(vendorId: string, items: ReorderItem[]): ReorderVendor {
  return { vendorId, vendorName: vendorId, scheduleKnown: true, nextDeliveryDate: '2026-07-07', daysUntilNextDelivery: 1, onHandSource: 'eod', eodSubmittedAt: null, items, vendorTotalCost: 0 };
}
function payloadOf(vendors: ReorderVendor[]): ReorderPayload {
  return { asOfDate: '2026-07-06', vendors, kpis: { vendorCount: vendors.length, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 }, warnings: [] };
}

describe('planSyscoExport', () => {
  it('resolves the per-store customer number and names the file', () => {
    const p = payloadOf([vendorOf('v-sysco', [caseItem()]), vendorOf('v-other', [caseItem()])]);
    const cfg = { id: 'v-sysco', accountNumber: 'DEFAULT', importCustomerNumbers: { 's-tw': '239415' } };
    const plan = planSyscoExport(p, 's-tw', 'Towson', cfg, () => '4671368');
    expect(plan.included).toBe(1);
    expect(plan.otherVendorCount).toBe(1);
    expect(plan.customerNumberMissing).toBe(false);
    expect(plan.filename).toBe('SYSCO_Order_Towson_2026-07-06.csv');
    expect(plan.csv.split('\r\n')[0].split(',')[3]).toBe('239415');
  });

  it('falls back to account_number, and flags a missing customer number', () => {
    const p = payloadOf([vendorOf('v-sysco', [caseItem()])]);
    expect(planSyscoExport(p, 's-x', 'X', { id: 'v-sysco', accountNumber: 'ACCT' }, () => 'c').customerNumberMissing).toBe(false);
    expect(planSyscoExport(p, 's-x', 'X', { id: 'v-sysco' }, () => 'c').customerNumberMissing).toBe(true);
  });
});
