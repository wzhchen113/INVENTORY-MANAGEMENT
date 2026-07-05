// src/lib/csvImport.test.ts — Spec 115 (W-1, AC-7) + the §0/§3 RECONCILE-SAFETY pin.
//
// Pins the CSV `vendor_sku` → `item_vendors.order_code` write path:
//   - vendor resolution (AC-2): matched `vendor_name` → that vendor; blank
//     `vendor_name` → the item's primary link; unmatched name / no primary →
//     skip + report (never a guessed write; a cell never creates a vendor).
//   - blank-cell no-op (AC-4): a blank/whitespace `vendor_sku` cell sends NO
//     `vendors` key → never clears an existing code.
//   - the three result counts (AC-5): codesWritten / linksCreated / codeRowsSkipped.
//   - the `skip('no changes')`-with-a-new-code promotion (§3): a row whose ONLY
//     change is a new code is not dropped.
//   - **RECONCILE-SAFETY (§0/§3, CRITICAL):** a CSV touching ONE vendor's code
//     resends the item's COMPLETE existing links (all links, all costs) with only
//     the target orderCode overwritten — it does NOT drop the item's other links
//     or alter any cost. This is the #1 non-negotiable pin.

import {
  computeDiff,
  commitImport,
  resolveVendorForCode,
  buildOrderCodeVendorsPayload,
  type ColumnMapping,
  type CommitContext,
} from './csvImport';
import type { InventoryItem, ItemVendorLink } from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────────
const STORE = 'store-1';
const VENDOR_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const VENDOR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const VENDOR_C = 'cccccccc-0000-0000-0000-000000000003';

const brandVendors = [
  { id: VENDOR_A, name: 'US Foods' },
  { id: VENDOR_B, name: 'Sysco' },
  { id: VENDOR_C, name: 'BJs Wholesale' },
];

const link = (vendorId: string, costPerUnit: number, casePrice: number, orderCode = '', isPrimary = false): ItemVendorLink => ({
  vendorId,
  vendorName: brandVendors.find((v) => v.id === vendorId)?.name || '',
  costPerUnit,
  casePrice,
  isPrimary,
  orderCode,
});

const makeItem = (over: Partial<InventoryItem>): InventoryItem => ({
  id: 'item-1',
  catalogId: 'cat-1',
  name: 'Chicken Thigh',
  category: 'Protein',
  unit: 'each',
  currentStock: 0,
  parLevel: 10,
  costPerUnit: 5,
  vendorId: VENDOR_A,
  vendorName: 'US Foods',
  caseQty: 24,
  casePrice: 50,
  subUnitSize: 1,
  subUnitUnit: '',
  averageDailyUsage: 0,
  safetyStock: 0,
  usagePerPortion: 0,
  eodRemaining: 0,
  storeId: STORE,
  lastUpdatedBy: '',
  lastUpdatedAt: '',
  ...over,
});

// A column mapping covering name + vendor_name + vendor_sku (the W-1 columns).
const MAPPING: ColumnMapping[] = [
  { csv: 'Item Name', field: 'name', match: 'auto' },
  { csv: 'Vendor', field: 'vendor_name', match: 'auto' },
  { csv: 'Vendor Code', field: 'vendor_sku', match: 'auto' },
];

// A recording CommitContext — captures every addItem/updateItem call so tests
// assert the exact `vendors` payload (or its ABSENCE) that reached the store.
function recordingCtx(inventory: InventoryItem[]): CommitContext & {
  updates: Array<{ id: string; updates: any }>;
  creates: any[];
} {
  const updates: Array<{ id: string; updates: any }> = [];
  const creates: any[] = [];
  return {
    addItem: (item) => creates.push(item),
    updateItem: (id, u) => updates.push({ id, updates: u }),
    storeId: STORE,
    brandVendors,
    inventory,
    updates,
    creates,
  };
}

// ─── resolveVendorForCode (AC-2) ─────────────────────────────────────────────
describe('resolveVendorForCode — vendor resolution rule (AC-2, fail-safe OQ-2)', () => {
  it('matches vendor_name case-insensitively to a brand vendor id', () => {
    expect(resolveVendorForCode({ vendorNameRaw: 'us foods', brandVendors })).toEqual({ vendorId: VENDOR_A });
    expect(resolveVendorForCode({ vendorNameRaw: '  SYSCO  ', brandVendors })).toEqual({ vendorId: VENDOR_B });
  });

  it('an unmatched vendor_name SKIPS (never falls back to primary — fail-safe)', () => {
    expect(
      resolveVendorForCode({ vendorNameRaw: 'Gordon Food', itemPrimaryVendorId: VENDOR_A, brandVendors }),
    ).toEqual({ skip: 'unmatched_vendor', name: 'Gordon Food' });
  });

  it('a blank vendor_name falls back to the item primary vendor', () => {
    expect(resolveVendorForCode({ vendorNameRaw: '', itemPrimaryVendorId: VENDOR_B, brandVendors })).toEqual({ vendorId: VENDOR_B });
    expect(resolveVendorForCode({ vendorNameRaw: '   ', itemPrimaryVendorId: VENDOR_B, brandVendors })).toEqual({ vendorId: VENDOR_B });
  });

  it('a blank vendor_name with NO primary skips no_vendor', () => {
    expect(resolveVendorForCode({ vendorNameRaw: '', brandVendors })).toEqual({ skip: 'no_vendor' });
  });
});

// ─── buildOrderCodeVendorsPayload — the reconcile-safe merge (§3) ─────────────
describe('buildOrderCodeVendorsPayload — RECONCILE-SAFE merge (§0/§3)', () => {
  it('resends ALL existing links, overwriting ONLY the target orderCode, preserving every cost', () => {
    const links = [link(VENDOR_A, 5, 50, 'OLD-A'), link(VENDOR_B, 7, 70, 'KEEP-B')];
    const { payload, createdLink } = buildOrderCodeVendorsPayload(links, VENDOR_A, 'NEW-A');
    expect(createdLink).toBe(false);
    // B's link + cost UNTOUCHED; A's code overwritten, A's cost preserved.
    expect(payload).toEqual([
      { vendorId: VENDOR_A, costPerUnit: 5, casePrice: 50, orderCode: 'NEW-A' },
      { vendorId: VENDOR_B, costPerUnit: 7, casePrice: 70, orderCode: 'KEEP-B' },
    ]);
  });

  it('appends a NEW non-primary link (cost/case 0) when the vendor is not yet linked, keeping the others', () => {
    const links = [link(VENDOR_A, 5, 50, 'A-CODE')];
    const { payload, createdLink } = buildOrderCodeVendorsPayload(links, VENDOR_B, 'B-NEW');
    expect(createdLink).toBe(true);
    expect(payload).toEqual([
      { vendorId: VENDOR_A, costPerUnit: 5, casePrice: 50, orderCode: 'A-CODE' }, // untouched
      { vendorId: VENDOR_B, costPerUnit: 0, casePrice: 0, orderCode: 'B-NEW' },   // appended
    ]);
  });

  it('on a create (no existing links) collapses to a single link', () => {
    const { payload, createdLink } = buildOrderCodeVendorsPayload([], VENDOR_A, 'CODE');
    expect(createdLink).toBe(true);
    expect(payload).toEqual([{ vendorId: VENDOR_A, costPerUnit: 0, casePrice: 0, orderCode: 'CODE' }]);
  });
});

// ─── commitImport — the CRITICAL reconcile-safety pin end-to-end ──────────────
describe('commitImport — CSV code write does NOT drop links or alter costs (CRITICAL)', () => {
  it('writing a code to ONE vendor resends the item COMPLETE existing link set with all costs intact', () => {
    // Item links THREE vendors, each with its own cost/case price. The CSV writes
    // a code for vendor A only (blank vendor_name → primary = A).
    const item = makeItem({
      vendorId: VENDOR_A,
      vendors: [
        link(VENDOR_A, 5, 50, '', true),
        link(VENDOR_B, 7, 70, 'B-KEPT'),
        link(VENDOR_C, 9, 90, 'C-KEPT'),
      ],
    });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': '', 'Vendor Code': 'A-NEW-CODE' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);

    // Exactly one updateItem, carrying the FULL 3-link set.
    expect(ctx.updates).toHaveLength(1);
    const sent = ctx.updates[0].updates.vendors;
    expect(sent).toEqual([
      { vendorId: VENDOR_A, costPerUnit: 5, casePrice: 50, orderCode: 'A-NEW-CODE' }, // code written
      { vendorId: VENDOR_B, costPerUnit: 7, casePrice: 70, orderCode: 'B-KEPT' },     // NOT dropped, cost intact
      { vendorId: VENDOR_C, costPerUnit: 9, casePrice: 90, orderCode: 'C-KEPT' },     // NOT dropped, cost intact
    ]);
    // No link created (A already linked); one code written.
    expect(result.codesWritten).toBe(1);
    expect(result.linksCreated).toBe(0);
    expect(result.codeRowsSkipped).toHaveLength(0);
  });

  it('writing a code to a NOT-yet-linked vendor appends a link and preserves existing links + costs', () => {
    const item = makeItem({
      vendorId: VENDOR_A,
      vendors: [link(VENDOR_A, 5, 50, 'A', true)],
    });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': 'Sysco', 'Vendor Code': 'SYS-1' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);

    const sent = ctx.updates[0].updates.vendors;
    expect(sent).toEqual([
      { vendorId: VENDOR_A, costPerUnit: 5, casePrice: 50, orderCode: 'A' },        // preserved
      { vendorId: VENDOR_B, costPerUnit: 0, casePrice: 0, orderCode: 'SYS-1' },     // appended
    ]);
    expect(result.codesWritten).toBe(1);
    expect(result.linksCreated).toBe(1);
  });
});

// ─── commitImport — blank cell no-op (AC-4) ──────────────────────────────────
describe('commitImport — blank vendor_sku cell is a no-op (AC-4)', () => {
  it('a blank code cell sends NO `vendors` key (does not clear the existing code)', () => {
    const item = makeItem({
      name: 'Fry Oil',
      vendors: [link(VENDOR_A, 5, 50, 'EXISTING-CODE', true)],
    });
    // Item-field change (par 10 → 20 via last_cost? use name-only change): change
    // the category so the row is an UPDATE, but leave the vendor_sku blank.
    const mapping: ColumnMapping[] = [
      { csv: 'Item Name', field: 'name', match: 'auto' },
      { csv: 'Category', field: 'category', match: 'auto' },
      { csv: 'Vendor Code', field: 'vendor_sku', match: 'auto' },
    ];
    const rows = [{ 'Item Name': 'Fry Oil', 'Category': 'Oils', 'Vendor Code': '   ' }];
    const diff = computeDiff(rows, mapping, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);

    expect(ctx.updates).toHaveLength(1);
    // The item field changed, but NO vendors key → db.ts leaves the link set +
    // its existing code untouched.
    expect(ctx.updates[0].updates.category).toBe('Oils');
    expect('vendors' in ctx.updates[0].updates).toBe(false);
    expect(result.codesWritten).toBe(0);
  });

  it('a blank code cell on an otherwise-unchanged row produces no update at all (true no-op)', () => {
    const item = makeItem({ name: 'Salt', vendors: [link(VENDOR_A, 5, 50, 'SALT-1', true)] });
    const rows = [{ 'Item Name': 'Salt', 'Vendor': '', 'Vendor Code': '' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);
    expect(ctx.updates).toHaveLength(0);
    expect(result.updated).toBe(0);
    expect(result.codesWritten).toBe(0);
    expect(result.codeRowsSkipped).toHaveLength(0);
  });
});

// ─── commitImport — vendor resolution branches end-to-end (AC-7) ─────────────
describe('commitImport — vendor resolution on write (AC-7)', () => {
  it('matched vendor_name writes the code to THAT vendor (not the primary)', () => {
    const item = makeItem({
      vendorId: VENDOR_A,
      vendors: [link(VENDOR_A, 5, 50, '', true), link(VENDOR_B, 7, 70, '')],
    });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': 'Sysco', 'Vendor Code': 'SYS-9' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);
    const sent = ctx.updates[0].updates.vendors;
    // The code lands on B (the named vendor), NOT A (the primary).
    expect(sent.find((l: any) => l.vendorId === VENDOR_B).orderCode).toBe('SYS-9');
    expect(sent.find((l: any) => l.vendorId === VENDOR_A).orderCode).toBe('');
    expect(result.codesWritten).toBe(1);
  });

  it('blank vendor_name writes the code to the item PRIMARY link', () => {
    const item = makeItem({ vendorId: VENDOR_A, vendors: [link(VENDOR_A, 5, 50, '', true)] });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': '', 'Vendor Code': 'PRIMARY-CODE' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    commitImport(diff, ctx);
    expect(ctx.updates[0].updates.vendors[0]).toEqual({ vendorId: VENDOR_A, costPerUnit: 5, casePrice: 50, orderCode: 'PRIMARY-CODE' });
  });

  it('unmatched vendor_name + code is SKIPPED and REPORTED (the CODE is not written to a guessed vendor)', () => {
    // Use the SAME item vendorName so the vendor_name column is not itself an
    // item-field change — isolating the CODE-skip path. (When vendor_name DOES
    // differ, the item's primary vendorName still updates per spec 114; only the
    // per-vendor CODE is skipped — covered by the mixed-batch test's create rows.)
    const item = makeItem({ vendorName: 'US Foods', vendorId: VENDOR_A, vendors: [link(VENDOR_A, 5, 50, 'A', true)] });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': 'US Foods Regional', 'Vendor Code': 'GFS-1' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);
    // The code targeted an unmatched vendor ("US Foods Regional" ≠ any brand
    // vendor) → skipped, NOT written. (The item's vendorName field does update to
    // the new string — spec 114 primary-name behavior — but NO `vendors` code
    // payload rides along.)
    const codeUpdate = ctx.updates.find((u) => 'vendors' in u.updates);
    expect(codeUpdate).toBeUndefined();
    expect(result.codesWritten).toBe(0);
    expect(result.codeRowsSkipped).toEqual([
      { item: 'Chicken Thigh', reason: 'unmatched_vendor', vendorName: 'US Foods Regional' },
    ]);
  });

  it('a code on a CREATE with no matching vendor name and no primary skips no_vendor', () => {
    const rows = [{ 'Item Name': 'Brand New Item', 'Vendor': '', 'Vendor Code': 'ORPHAN' }];
    const diff = computeDiff(rows, MAPPING, [], STORE, brandVendors);
    const ctx = recordingCtx([]);
    const result = commitImport(diff, ctx);
    expect(ctx.creates).toHaveLength(1);
    expect('vendors' in ctx.creates[0]).toBe(false); // no link written
    expect(result.codeRowsSkipped).toEqual([{ item: 'Brand New Item', reason: 'no_vendor' }]);
  });

  it('a code on a CREATE naming an existing vendor attaches a link on the new item', () => {
    const rows = [{ 'Item Name': 'Brand New Item', 'Vendor': 'US Foods', 'Vendor Code': 'US-NEW' }];
    const diff = computeDiff(rows, MAPPING, [], STORE, brandVendors);
    const ctx = recordingCtx([]);
    const result = commitImport(diff, ctx);
    expect(ctx.creates[0].vendors).toEqual([{ vendorId: VENDOR_A, costPerUnit: 0, casePrice: 0, orderCode: 'US-NEW' }]);
    expect(result.codesWritten).toBe(1);
    expect(result.linksCreated).toBe(1);
  });
});

// ─── computeDiff — skip('no changes')-with-new-code promotion (§3) ────────────
describe('computeDiff / commitImport — a code-only change is not dropped (§3 promotion)', () => {
  it('promotes a row whose ONLY change is a new code to an update, writing the code', () => {
    const item = makeItem({ vendorId: VENDOR_A, vendors: [link(VENDOR_A, 5, 50, 'OLD', true)] });
    // Same name/vendor → no item-field change; only the code differs.
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': '', 'Vendor Code': 'BRAND-NEW' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    // The op is an update, not a skip.
    expect(diff.ops.find((o) => o.itemId === item.id)?.type).toBe('update');
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);
    expect(result.codesWritten).toBe(1);
    expect(ctx.updates[0].updates.vendors[0].orderCode).toBe('BRAND-NEW');
  });

  it('a code EQUAL to the existing link code stays a no-op (idempotent re-run)', () => {
    const item = makeItem({ vendorId: VENDOR_A, vendors: [link(VENDOR_A, 5, 50, 'SAME', true)] });
    const rows = [{ 'Item Name': 'Chicken Thigh', 'Vendor': '', 'Vendor Code': 'SAME' }];
    const diff = computeDiff(rows, MAPPING, [item], STORE, brandVendors);
    expect(diff.ops.find((o) => o.existing?.id === item.id)?.type).toBe('skip');
    const ctx = recordingCtx([item]);
    const result = commitImport(diff, ctx);
    expect(ctx.updates).toHaveLength(0);
    expect(result.codesWritten).toBe(0);
    expect(result.codeRowsSkipped).toHaveLength(0);
  });
});

// ─── commitImport — mixed batch counts (AC-5) ────────────────────────────────
describe('commitImport — three result counts for a mixed batch (AC-5)', () => {
  it('counts codesWritten / linksCreated / codeRowsSkipped across a mixed batch', () => {
    const existing = [
      makeItem({ id: 'i1', name: 'Item One', vendorId: VENDOR_A, vendors: [link(VENDOR_A, 5, 50, '', true)] }),
      makeItem({ id: 'i2', name: 'Item Two', vendorId: VENDOR_A, vendors: [link(VENDOR_A, 6, 60, '', true)] }),
    ];
    const rows = [
      { 'Item Name': 'Item One', 'Vendor': '', 'Vendor Code': 'CODE-1' },          // write to primary (A)
      { 'Item Name': 'Item Two', 'Vendor': 'Sysco', 'Vendor Code': 'SYS-2' },      // new link (B) → code + link
      { 'Item Name': 'Item Three', 'Vendor': 'Nonexistent', 'Vendor Code': 'X' },  // create, unmatched vendor → skip
      { 'Item Name': 'Item Four', 'Vendor': 'US Foods', 'Vendor Code': 'US-4' },   // create, matched → code + link
    ];
    const diff = computeDiff(rows, MAPPING, existing, STORE, brandVendors);
    const ctx = recordingCtx(existing);
    const result = commitImport(diff, ctx);

    // Item One: code on existing link. Item Two: code + new link. Item Four:
    // create with a matched vendor → code + link. Item Three: create, code skipped.
    expect(result.codesWritten).toBe(3);
    expect(result.linksCreated).toBe(2); // Two (append) + Four (new item link)
    expect(result.codeRowsSkipped).toEqual([{ item: 'Item Three', reason: 'unmatched_vendor', vendorName: 'Nonexistent' }]);
  });
});
