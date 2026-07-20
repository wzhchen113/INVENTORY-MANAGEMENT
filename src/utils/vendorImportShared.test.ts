// src/utils/vendorImportShared.test.ts — the format-agnostic helpers shared by
// the US Foods + SYSCO import builders.
import type { ReorderItem, ReorderPayload, ReorderVendor, Vendor } from '../types';
import {
  csvSafe,
  deriveOrderLine,
  isImportFormat,
  isOrdered,
  orderQuantities,
  pickImportVendor,
  resolveExportBase,
} from './vendorImportShared';

function item(over: Partial<ReorderItem> = {}): ReorderItem {
  return {
    itemId: 'i', itemName: 'X', unit: 'each', onHand: 0, pendingPoQty: 0, parLevel: 0,
    usageForecasted: 0, parReplacement: 0, suggestedQty: 0, costPerUnit: 1, estimatedCost: 0,
    caseQty: 1, suggestedCases: null, suggestedUnits: 0, flags: [], ...over,
  };
}

describe('csvSafe', () => {
  it.each(['=cmd', '+1', '-1', '@x', '\tx', '\rx'])('neutralizes a leading %j', (v) => {
    expect(csvSafe(v)).toBe(`'${v}`);
  });
  it('leaves a safe value untouched', () => {
    expect(csvSafe('8328700')).toBe('8328700');
    expect(csvSafe('Rice Parboiled')).toBe('Rice Parboiled');
  });
});

describe('isOrdered / orderQuantities', () => {
  it('excludes have-enough and zero-qty items', () => {
    expect(isOrdered(item({ needsOrder: false, suggestedCases: 2 }))).toBe(false);
    expect(isOrdered(item({ suggestedQty: 0, suggestedCases: null }))).toBe(false);
    expect(isOrdered(item({ suggestedCases: 3 }))).toBe(true);
    expect(isOrdered(item({ suggestedQty: 5, suggestedCases: null }))).toBe(true);
  });
  it('splits cases vs units', () => {
    expect(orderQuantities(item({ suggestedCases: 4 }))).toEqual({ cases: 4, units: 0 });
    expect(orderQuantities(item({ suggestedCases: null, suggestedQty: 6 }))).toEqual({ cases: 0, units: 6 });
  });
});

describe('deriveOrderLine', () => {
  it('derives pack size + case/each prices from the server-rounded total', () => {
    const line = deriveOrderLine(item({ suggestedCases: 4, caseQty: 4, unit: 'bags', estimatedCost: 100 }));
    expect(line).toEqual({ cases: 4, units: 0, packSize: '4 bags', casePrice: '25.00', eachPrice: '' });
  });
  it('no pack size when caseQty <= 1; price rides on the unit total', () => {
    const line = deriveOrderLine(item({ suggestedCases: null, suggestedQty: 5, caseQty: 1, estimatedCost: 30 }));
    expect(line.packSize).toBe('');
    expect(line.eachPrice).toBe('6.00');
    expect(line.casePrice).toBe('');
  });
});

describe('isImportFormat', () => {
  it('recognizes only the known tags', () => {
    expect(isImportFormat('us_foods')).toBe(true);
    expect(isImportFormat('sysco')).toBe(true);
    expect(isImportFormat('')).toBe(false);
    expect(isImportFormat(null)).toBe(false);
    expect(isImportFormat('bjs')).toBe(false);
  });
});

// ── pickImportVendor — the onCsvPress branch decision (AC8) ──
function vendorRow(id: string, orderImportFormat?: 'us_foods' | 'sysco' | ''): Vendor {
  return {
    id, brandId: 'b', name: id, contactName: '', phone: '', email: '', accountNumber: '',
    leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case', orderImportFormat,
    extensionOrdering: false, orderPageUrl: null,
  };
}
function payload(vendorIds: string[]): ReorderPayload {
  const vendors: ReorderVendor[] = vendorIds.map((vid) => ({
    vendorId: vid, vendorName: vid, scheduleKnown: true, nextDeliveryDate: '', daysUntilNextDelivery: 1,
    onHandSource: 'eod', eodSubmittedAt: null, items: [], vendorTotalCost: 0,
  }));
  return { asOfDate: '2026-07-06', vendors, kpis: { vendorCount: vendors.length, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 }, warnings: [] };
}

describe('pickImportVendor', () => {
  it('returns undefined when no displayed vendor is import-configured', () => {
    const vendors = [vendorRow('v1'), vendorRow('v2', '')];
    expect(pickImportVendor(payload(['v1', 'v2']), vendors)).toBeUndefined();
  });
  it('picks a us_foods vendor present in the payload', () => {
    const vendors = [vendorRow('v1'), vendorRow('vUS', 'us_foods')];
    expect(pickImportVendor(payload(['v1', 'vUS']), vendors)?.id).toBe('vUS');
  });
  it('picks a sysco vendor too', () => {
    const vendors = [vendorRow('vSY', 'sysco')];
    expect(pickImportVendor(payload(['vSY']), vendors)?.id).toBe('vSY');
  });
  it('ignores an import-configured vendor NOT in the displayed payload', () => {
    const vendors = [vendorRow('vUS', 'us_foods'), vendorRow('v1')];
    expect(pickImportVendor(payload(['v1']), vendors)).toBeUndefined();
  });
  it('follows payload order (first displayed import vendor wins)', () => {
    const vendors = [vendorRow('vSY', 'sysco'), vendorRow('vUS', 'us_foods')];
    expect(pickImportVendor(payload(['vUS', 'vSY']), vendors)?.id).toBe('vUS');
  });
});

describe('resolveExportBase', () => {
  const cfg = { id: 'vX', accountNumber: 'ACCT', importCustomerNumbers: { s1: '111' } };
  it('resolves per-store customer number, items, and omitted-vendor count', () => {
    const p = payload(['vX', 'vOther']);
    p.vendors[0].items = [item({ suggestedCases: 1 })];
    const base = resolveExportBase(p, 's1', cfg);
    expect(base.customerNumber).toBe('111');
    expect(base.items).toHaveLength(1);
    expect(base.otherVendorCount).toBe(1);
    expect(base.customerNumberMissing).toBe(false);
    expect(base.date).toBe('2026-07-06');
  });
  it('falls back to account_number, then flags missing', () => {
    expect(resolveExportBase(payload(['vX']), 's2', cfg).customerNumber).toBe('ACCT');
    expect(resolveExportBase(payload(['vX']), 's2', { id: 'vX' }).customerNumberMissing).toBe(true);
  });
});
