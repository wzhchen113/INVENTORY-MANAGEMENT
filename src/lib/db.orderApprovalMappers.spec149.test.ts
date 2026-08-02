// src/lib/db.orderApprovalMappers.spec149.test.ts — spec 149 review round
// (test-engineer Should-fix 3).
//
// The snake_case ⇄ camelCase translation layer for the spec-149 surfaces was
// the one piece of glue with NO jest coverage: the store suite mocks `db`
// wholesale (by design), so nothing exercised the actual property renames.
// A silent rename drift (`external_ref_expires_at` → `externalRefExpiresAt`,
// `source_submission_id` → `sourceSubmissionId`, the line-row shape the RPC
// consumes, the `order_channel` / `instacart_retailer_key` vendor columns)
// would type-check and pass every other suite while breaking in production.
//
// The mappers are module-private, so they are exercised through their public
// callers with a stubbed supabase client — the same boundary
// db.updateVendor.test.ts / db.updateStore.test.ts use.

let builders: Record<string, any> = {};
const mockRpc = jest.fn();

const mockFrom = jest.fn((table: string) => {
  const b = builders[table];
  if (!b) throw new Error(`unexpected table in db.orderApprovalMappers test: ${table}`);
  return b;
});

jest.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...a: unknown[]) => mockRpc(...a),
  },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import {
  createOrderApproval,
  fetchOrderApproval,
  advanceOrderApproval,
  fetchEodSubmissionContext,
  fetchVendors,
  type OrderApprovalLine,
} from './db';

/** A complete PostgREST row exactly as `order_approvals` returns it. */
const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 'ap-1',
  store_id: 'store-1',
  vendor_id: 'v1',
  // Postgres `date` can come back with a time component depending on the
  // client — the mapper must clip to YYYY-MM-DD.
  business_date: '2026-08-01T00:00:00+00:00',
  approved_by: 'user-1',
  approved_at: '2026-08-01T12:00:00Z',
  channel: 'instacart',
  status: 'approved',
  lines: [
    {
      item_id: 'item-1',
      item_name: 'Buns',
      qty_base: '5',            // numeric arrives as a STRING over PostgREST
      case_qty: '6',
      unit: 'each',
      cost_per_counted_unit: '8.25',
    },
  ],
  line_count: '1',
  est_total_cost: '41.25',
  external_ref: 'https://instacart.example/c/1',
  external_ref_expires_at: '2026-08-08T12:00:00Z',
  ordered_at: null,
  source_submission_id: 'sub-1',
  ...over,
});

/** Chainable builder whose terminal `maybeSingle()` resolves `result`. */
function selectBuilder(result: { data: unknown; error: unknown }) {
  const b: any = {};
  for (const m of ['select', 'eq', 'update', 'abortSignal']) b[m] = jest.fn(() => b);
  b.maybeSingle = jest.fn().mockResolvedValue(result);
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  builders = {};
});

describe('mapOrderApproval — snake_case row → OrderApproval', () => {
  it('renames every column and coerces the numeric strings', async () => {
    builders.order_approvals = selectBuilder({ data: dbRow(), error: null });

    const approval = await fetchOrderApproval({
      storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    });

    expect(approval).toEqual({
      id: 'ap-1',
      storeId: 'store-1',
      vendorId: 'v1',
      businessDate: '2026-08-01',
      approvedBy: 'user-1',
      approvedAt: '2026-08-01T12:00:00Z',
      channel: 'instacart',
      status: 'approved',
      lines: [{
        itemId: 'item-1',
        itemName: 'Buns',
        qtyBase: 5,
        caseQty: 6,
        unit: 'each',
        costPerCountedUnit: 8.25,
      }],
      lineCount: 1,
      estTotalCost: 41.25,
      externalRef: 'https://instacart.example/c/1',
      externalRefExpiresAt: '2026-08-08T12:00:00Z',
      orderedAt: null,
      sourceSubmissionId: 'sub-1',
    });
  });

  it('degrades an unrecognized channel literal to `manual` (never mints a link)', async () => {
    builders.order_approvals = selectBuilder({ data: dbRow({ channel: 'carrier_pigeon' }), error: null });
    const approval = await fetchOrderApproval({
      storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    });
    expect(approval?.channel).toBe('manual');
  });

  it('degrades an unrecognized status to `pending` (retriable, never fake-approved)', async () => {
    builders.order_approvals = selectBuilder({ data: dbRow({ status: 'weird' }), error: null });
    const approval = await fetchOrderApproval({
      storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    });
    expect(approval?.status).toBe('pending');
  });

  it('tolerates a null/absent line array and null-ish optional columns', async () => {
    builders.order_approvals = selectBuilder({
      data: dbRow({
        lines: null, line_count: null, est_total_cost: null,
        approved_by: null, external_ref: null, external_ref_expires_at: null,
        source_submission_id: null, status: 'pending', channel: 'manual',
      }),
      error: null,
    });
    const approval = await fetchOrderApproval({
      storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
    });
    expect(approval).toMatchObject({
      lines: [], lineCount: 0, estTotalCost: 0,
      approvedBy: null, externalRef: null, externalRefExpiresAt: null,
      sourceSubmissionId: null,
    });
  });

  it('a no-row read is null, not a fabricated approval', async () => {
    builders.order_approvals = selectBuilder({ data: null, error: null });
    await expect(
      fetchOrderApproval({ storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01' }),
    ).resolves.toBeNull();
  });

  it('scopes the read by store + vendor + date', async () => {
    const b = selectBuilder({ data: dbRow(), error: null });
    builders.order_approvals = b;
    await fetchOrderApproval({ storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01' });
    expect(b.eq.mock.calls).toEqual([
      ['store_id', 'store-1'], ['vendor_id', 'v1'], ['business_date', '2026-08-01'],
    ]);
  });
});

describe('toOrderApprovalLineRow — OrderApprovalLine → RPC payload', () => {
  const lines: OrderApprovalLine[] = [
    { itemId: 'item-1', itemName: 'Buns', qtyBase: 5, caseQty: 6, unit: 'each', costPerCountedUnit: 8.25 },
  ];

  it('sends snake_case line rows and the p_-prefixed RPC args', async () => {
    mockRpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: dbRow(), error: null }) });

    await createOrderApproval({
      storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01',
      sourceSubmissionId: 'sub-1', lines,
    });

    expect(mockRpc).toHaveBeenCalledWith('create_order_approval', {
      p_store_id: 'store-1',
      p_vendor_id: 'v1',
      p_business_date: '2026-08-01',
      p_submission_id: 'sub-1',
      p_lines: [{
        item_id: 'item-1',
        item_name: 'Buns',
        qty_base: 5,
        case_qty: 6,
        unit: 'each',
        cost_per_counted_unit: 8.25,
      }],
    });
    // AC-14 — the client never supplies the channel.
    expect(Object.keys(mockRpc.mock.calls[0][1])).not.toContain('p_channel');
  });

  it('an omitted submission id becomes an explicit null', async () => {
    mockRpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: dbRow(), error: null }) });
    await createOrderApproval({ storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01', lines });
    expect(mockRpc.mock.calls[0][1].p_submission_id).toBeNull();
  });

  it('maps a bare composite AND a single-element array response identically', async () => {
    mockRpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: dbRow(), error: null }) });
    const bare = await createOrderApproval({ storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01', lines });

    mockRpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: [dbRow()], error: null }) });
    const wrapped = await createOrderApproval({ storeId: 'store-1', vendorId: 'v1', businessDate: '2026-08-01', lines });

    expect(wrapped).toEqual(bare);
    expect(bare?.externalRefExpiresAt).toBe('2026-08-08T12:00:00Z');
  });
});

describe('advanceOrderApproval — camel patch → snake UPDATE body', () => {
  it('renames externalRef / externalRefExpiresAt and maps the row back', async () => {
    const b = selectBuilder({ data: dbRow({ status: 'ordered', ordered_at: '2026-08-01T13:00:00Z' }), error: null });
    builders.order_approvals = b;

    const out = await advanceOrderApproval('ap-1', {
      status: 'ordered',
      externalRef: 'po-9',
      externalRefExpiresAt: '2026-08-08T12:00:00Z',
    });

    expect(b.update).toHaveBeenCalledWith({
      status: 'ordered',
      external_ref: 'po-9',
      external_ref_expires_at: '2026-08-08T12:00:00Z',
    });
    expect(b.eq).toHaveBeenCalledWith('id', 'ap-1');
    expect(out).toMatchObject({ status: 'ordered', orderedAt: '2026-08-01T13:00:00Z' });
  });

  it('omit-key-to-skip: only the supplied keys reach the UPDATE body', async () => {
    const b = selectBuilder({ data: dbRow(), error: null });
    builders.order_approvals = b;
    await advanceOrderApproval('ap-1', { channel: 'extension' });
    expect(b.update).toHaveBeenCalledWith({ channel: 'extension' });
  });

  it('an EMPTY patch is a client-side no-op — no PATCH is issued', async () => {
    const b = selectBuilder({ data: dbRow(), error: null });
    builders.order_approvals = b;
    await expect(advanceOrderApproval('ap-1', {})).resolves.toBeNull();
    expect(b.update).not.toHaveBeenCalled();
  });

  it('a blank externalRef clears the column to NULL rather than writing ""', async () => {
    const b = selectBuilder({ data: dbRow(), error: null });
    builders.order_approvals = b;
    await advanceOrderApproval('ap-1', { externalRef: '' });
    expect(b.update).toHaveBeenCalledWith({ external_ref: null });
  });
});

describe('fetchEodSubmissionContext — deep-link row mapping', () => {
  it('renames store_id/vendor_id/date and clips the business date', async () => {
    builders.eod_submissions = selectBuilder({
      data: {
        id: 'sub-1', store_id: 'store-1', vendor_id: 'v1',
        date: '2026-08-01T00:00:00+00:00', status: 'submitted',
        submitted_at: '2026-08-01T11:00:00Z',
      },
      error: null,
    });

    await expect(fetchEodSubmissionContext('sub-1')).resolves.toEqual({
      id: 'sub-1',
      storeId: 'store-1',
      vendorId: 'v1',
      businessDate: '2026-08-01',
      status: 'submitted',
      submittedAt: '2026-08-01T11:00:00Z',
    });
  });

  it('a vendor-less submission maps to an empty vendorId, not undefined', async () => {
    builders.eod_submissions = selectBuilder({
      data: { id: 'sub-2', store_id: 'store-1', vendor_id: null, date: '2026-08-01', status: 'submitted', submitted_at: null },
      error: null,
    });
    await expect(fetchEodSubmissionContext('sub-2')).resolves.toMatchObject({
      vendorId: '', submittedAt: null,
    });
  });

  it('an unreadable (RLS-clipped) submission is null', async () => {
    builders.eod_submissions = selectBuilder({ data: null, error: null });
    await expect(fetchEodSubmissionContext('nope')).resolves.toBeNull();
  });
});

describe('mapVendor — the two spec-149 columns', () => {
  function vendorsBuilder(rows: unknown[]) {
    const b: any = {};
    b.select = jest.fn(() => b);
    b.order = jest.fn(() => b);
    b.eq = jest.fn(() => b);
    b.abortSignal = jest.fn().mockResolvedValue({ data: rows, error: null });
    return b;
  }

  const vendorRow = (over: Record<string, unknown> = {}) => ({
    id: 'v1', brand_id: 'b1', name: "Sam's", order_unit: 'case',
    extension_ordering: false, order_page_url: null,
    order_channel: 'instacart', instacart_retailer_key: 'sams_club',
    ...over,
  });

  it('maps order_channel + instacart_retailer_key into camelCase', async () => {
    builders.vendors = vendorsBuilder([vendorRow()]);
    const [v] = await fetchVendors('b1');
    expect(v).toMatchObject({ orderChannel: 'instacart', instacartRetailerKey: 'sams_club' });
  });

  it('a pre-migration row (columns absent) degrades to null, not undefined', async () => {
    builders.vendors = vendorsBuilder([
      { id: 'v1', brand_id: 'b1', name: "Sam's", order_unit: 'case' },
    ]);
    const [v] = await fetchVendors('b1');
    expect(v.orderChannel).toBeNull();
    expect(v.instacartRetailerKey).toBeNull();
  });

  it('an unrecognized stored channel literal is dropped to null (never routed on)', async () => {
    builders.vendors = vendorsBuilder([vendorRow({ order_channel: 'carrier_pigeon' })]);
    const [v] = await fetchVendors('b1');
    expect(v.orderChannel).toBeNull();
    // The retailer key survives — it is only meaningful with the instacart channel.
    expect(v.instacartRetailerKey).toBe('sams_club');
  });
});
