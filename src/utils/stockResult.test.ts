// src/utils/stockResult.test.ts — Spec 184: AC-33, AC-34, AC-39, AC-41, R-5, D-15.

import type { StockStoreResult } from '../lib/db';
import {
  buildStockResultLines,
  buildStoreCreatedLines,
  customerNumberCheckFailedLine,
  customerNumberWarningLine,
  vendorsMissingCustomerNumber,
  type StockResultLine,
} from './stockResult';

const RESULT: StockStoreResult = {
  itemsCopied: 149,
  itemsSkipped: 0,
  linksAdded: 150,
  linksSkippedCrossBrand: 0,
  extrasAdded: 0,
  extrasSkipped: 0,
  itemsNoVendorLink: 0,
  targetHasOrderSchedule: true,
  uncarriedRemaining: 0,
};
const CTX = { sourceName: 'Towson', targetName: 'Kenyon' };
const ids = (lines: StockResultLine[]) => lines.map((l) => l.id);
const textOf = (lines: StockResultLine[], id: string) => lines.find((l) => l.id === id)?.text;

describe('buildStockResultLines (AC-33, AC-34)', () => {
  it('reports copied and skipped, and hides every zero-count line', () => {
    const lines = buildStockResultLines(RESULT, CTX);
    expect(ids(lines)).toEqual(['copied', 'skipped']);
    expect(textOf(lines, 'copied')).toBe(
      'Copied 149 items and 150 vendor links from Towson to Kenyon. Stock starts at 0.',
    );
    expect(textOf(lines, 'skipped')).toBe('Skipped 0 items Kenyon already had, left unchanged.');
  });

  it('reports ticked rows once any were ticked, and skipped ticks only above 0', () => {
    const added = buildStockResultLines({ ...RESULT, extrasAdded: 2 }, CTX);
    expect(textOf(added, 'extras-added')).toBe('Added 2 ticked catalog rows with blank par and cost.');
    expect(ids(added)).not.toContain('extras-skipped');

    const skipped = buildStockResultLines({ ...RESULT, extrasSkipped: 1 }, CTX);
    expect(textOf(skipped, 'extras-added')).toBe('Added 0 ticked catalog rows with blank par and cost.');
    expect(textOf(skipped, 'extras-skipped')).toBe('Skipped 1 ticked catalog row that a store now carries.');
  });

  it('reports items with no vendor link only above 0, as a warning', () => {
    const lines = buildStockResultLines({ ...RESULT, itemsNoVendorLink: 2 }, CTX);
    const line = lines.find((l) => l.id === 'no-vendor-link');
    expect(line?.tone).toBe('warn');
    expect(line?.text).toBe('2 added items have no vendor link, so they won’t appear at EOD until linked.');
    expect(textOf(buildStockResultLines({ ...RESULT, itemsNoVendorLink: 1 }, CTX), 'no-vendor-link')).toBe(
      '1 added item has no vendor link, so it won’t appear at EOD until linked.',
    );
  });

  it('reports cross-brand links only above 0', () => {
    expect(ids(buildStockResultLines({ ...RESULT, linksSkippedCrossBrand: 3 }, CTX))).toContain('links-cross-brand');
  });

  it('AC-34: warns when the target has no order schedule (H Street), not when it has one (Kenyon)', () => {
    const none = buildStockResultLines({ ...RESULT, targetHasOrderSchedule: false }, { ...CTX, targetName: 'H Street' });
    const line = none.find((l) => l.id === 'no-schedule');
    expect(line?.tone).toBe('warn');
    expect(line?.text).toBe('H Street has no order schedule, so staff EOD will show no vendors until one is set.');
    expect(ids(buildStockResultLines(RESULT, CTX))).not.toContain('no-schedule');
  });
});

describe('buildStoreCreatedLines (AC-39, AC-41, AC-42)', () => {
  const BASE = {
    storeId: 's-new',
    storeName: 'Canton',
    sourceName: null,
    result: null,
    stockFailed: false,
    canStockLater: true,
    uncarriedCount: 0,
  };

  it('AC-42: created and stocked gets the same content as a STOCK run', () => {
    const result = { ...RESULT, targetHasOrderSchedule: false };
    expect(buildStoreCreatedLines({ ...BASE, sourceName: 'Towson', result })).toEqual(
      buildStockResultLines(result, { sourceName: 'Towson', targetName: 'Canton' }),
    );
  });

  it('AC-41: says it was created but not stocked, and how to retry', () => {
    const lines = buildStoreCreatedLines({ ...BASE, sourceName: 'Towson', stockFailed: true });
    expect(lines).toEqual([
      {
        id: 'not-stocked',
        tone: 'warn',
        text: 'Canton was created but not stocked. Use STOCK on its row to try again.',
      },
    ]);
  });

  it("Don't stock yet says the store has no items and points at STOCK", () => {
    expect(ids(buildStoreCreatedLines(BASE))).toEqual(['no-items-yet']);
  });

  it('AC-39: names how many rows no store carries and that STOCK adds them', () => {
    const lines = buildStoreCreatedLines({ ...BASE, uncarriedCount: 3 });
    expect(textOf(lines, 'uncarried')).toBe(
      '3 catalog rows are carried by no store. Add them from this store’s STOCK action.',
    );
    const stocked = buildStoreCreatedLines({ ...BASE, sourceName: 'Towson', result: RESULT, uncarriedCount: 1 });
    expect(textOf(stocked, 'uncarried')).toBe(
      '1 catalog row is carried by no store. Add it from this store’s STOCK action.',
    );
  });

  it('AC-29 + AC-39: with no store to copy from, it does not point at a STOCK action that offers nothing', () => {
    expect(buildStoreCreatedLines({ ...BASE, canStockLater: false, uncarriedCount: 5 })).toEqual([]);
  });
});

describe('R-5 — no copy implies the full catalog', () => {
  it('holds across every line either builder can produce', () => {
    const noisy: StockStoreResult = {
      itemsCopied: 1,
      itemsSkipped: 1,
      linksAdded: 1,
      linksSkippedCrossBrand: 1,
      extrasAdded: 1,
      extrasSkipped: 1,
      itemsNoVendorLink: 1,
      targetHasOrderSchedule: false,
      uncarriedRemaining: 1,
    };
    const lines = [
      ...buildStockResultLines(noisy, CTX),
      ...buildStoreCreatedLines({
        storeId: 's',
        storeName: 'Kenyon',
        sourceName: 'Towson',
        result: noisy,
        stockFailed: false,
        canStockLater: true,
        uncarriedCount: 1,
      }),
    ];
    expect(lines.length).toBeGreaterThan(5);
    for (const { text } of lines) {
      expect(text).not.toMatch(/\b(full|whole|entire|complete|fully|all items|everything)\b/i);
    }
  });
});

describe('vendorsMissingCustomerNumber (D-15)', () => {
  const TARGET = 'store-target';
  const item = (vendorIds: string[] | undefined, storeId = TARGET, vendorId?: string) => ({
    storeId,
    vendorId: vendorId ?? '',
    vendorIds,
  });
  const usFoods = (importCustomerNumbers?: Record<string, string>) => ({
    id: 'v-us',
    name: 'US Foods',
    importCustomerNumbers,
  });

  it('warns: linked vendor, non-empty map, no entry for the target', () => {
    expect(
      vendorsMissingCustomerNumber(TARGET, [item(['v-us'])], [usFoods({ 'store-other': '111' })]),
    ).toEqual(['US Foods']);
  });

  it('does not warn when the entry exists', () => {
    expect(
      vendorsMissingCustomerNumber(TARGET, [item(['v-us'])], [usFoods({ [TARGET]: '222', 'store-other': '111' })]),
    ).toEqual([]);
  });

  it('does not warn on an empty map, which is a vendor with no per-store numbers', () => {
    expect(vendorsMissingCustomerNumber(TARGET, [item(['v-us'])], [usFoods({})])).toEqual([]);
  });

  it('does not warn on an absent map', () => {
    expect(vendorsMissingCustomerNumber(TARGET, [item(['v-us'])], [usFoods(undefined)])).toEqual([]);
  });

  it('warns on a blank entry, because the export falls back the same way', () => {
    expect(
      vendorsMissingCustomerNumber(TARGET, [item(['v-us'])], [usFoods({ [TARGET]: '', 'store-other': '111' })]),
    ).toEqual(['US Foods']);
  });

  it('ignores a vendor the target has no link to, and items at other stores', () => {
    const vendors = [usFoods({ 'store-other': '111' })];
    expect(vendorsMissingCustomerNumber(TARGET, [item(['v-other'])], vendors)).toEqual([]);
    expect(vendorsMissingCustomerNumber(TARGET, [item(['v-us'], 'store-other')], vendors)).toEqual([]);
  });

  it('counts every link of a multi-vendor item, and falls back to the scalar only with no link array', () => {
    const vendors = [
      usFoods({ 'store-other': '111' }),
      { id: 'v-sy', name: 'Sysco', importCustomerNumbers: { 'store-other': '333' } },
    ];
    expect(vendorsMissingCustomerNumber(TARGET, [item(['v-us', 'v-sy'])], vendors)).toEqual(['Sysco', 'US Foods']);
    expect(vendorsMissingCustomerNumber(TARGET, [item(undefined, TARGET, 'v-us')], vendors)).toEqual(['US Foods']);
    expect(vendorsMissingCustomerNumber(TARGET, [item([], TARGET, 'v-us')], vendors)).toEqual([]);
  });
});

describe('customer-number lines (D-15)', () => {
  it('names one vendor', () => {
    expect(customerNumberWarningLine(['US Foods'], 'H Street')).toEqual({
      id: 'customer-number',
      tone: 'warn',
      text: 'US Foods has no customer number for H Street, so its import-order file uses the default account number until one is added under Vendors.',
    });
  });

  it('names several vendors in one line', () => {
    expect(customerNumberWarningLine(['Sysco', 'US Foods'], 'H Street')?.text).toBe(
      'Sysco, US Foods have no customer number for H Street, so their import-order file uses the default account number until one is added under Vendors.',
    );
  });

  it('is null when no vendor is missing a number', () => {
    expect(customerNumberWarningLine([], 'H Street')).toBeNull();
  });

  it('a failed check says so rather than reading as no warning', () => {
    const line = customerNumberCheckFailedLine('H Street');
    expect(line.tone).toBe('warn');
    expect(line.text).toContain('Could not check vendor customer numbers for H Street');
  });
});
