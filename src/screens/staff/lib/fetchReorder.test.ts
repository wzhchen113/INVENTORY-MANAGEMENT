// src/screens/staff/lib/fetchReorder.test.ts — Spec 089 (B).
//
// The staff Reorder data carve-out. Mocks the supabase client boundary →
// asserts the report_reorder_list RPC mapping (case fields ride through
// unchanged, mirroring db.ts:mapReorderVendor) + the order_schedule read
// mapping to the shared OrderSchedule shape, and that a PostgREST RLS error
// (42501) is propagated (thrown) so the screen renders its error pane.

const mockRpc = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { fetchStaffOrderSchedule, fetchStaffReorder } from './fetchReorder';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fetchStaffReorder', () => {
  it('calls report_reorder_list with p_store_id + p_params.as_of_date', async () => {
    mockRpc.mockResolvedValueOnce({ data: { vendors: [], kpis: {}, _warnings: [] }, error: null });
    await fetchStaffReorder('store-1', '2026-06-02');
    expect(mockRpc).toHaveBeenCalledWith('report_reorder_list', {
      p_store_id: 'store-1',
      p_params: { as_of_date: '2026-06-02' },
    });
  });

  it('maps the spec-088 case fields through verbatim', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        as_of_date: '2026-06-02',
        vendors: [
          {
            vendor_id: 'v-1',
            vendor_name: 'Acme',
            schedule_known: true,
            next_delivery_date: '2026-06-03',
            days_until_next_delivery: 1,
            on_hand_source: 'eod',
            eod_submitted_at: '2026-06-02T10:00:00Z',
            vendor_total_cost: 144,
            items: [
              {
                item_id: 'i-1',
                item_name: 'Buns',
                unit: 'each',
                on_hand: 0,
                pending_po_qty: 0,
                par_level: 49,
                suggested_qty: 49,
                cost_per_unit: 2,
                estimated_cost: 144,
                case_qty: 24,
                suggested_cases: 3,
                suggested_units: 72,
                flags: ['no_par'],
              },
            ],
          },
        ],
        kpis: {
          vendor_count: 1,
          item_count: 1,
          total_estimated_cost: 144,
          eod_sourced_vendor_count: 1,
          stock_fallback_vendor_count: 0,
        },
        _warnings: [{ code: 'schedule_unknown', message: 'no schedule' }],
      },
      error: null,
    });

    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.asOfDate).toBe('2026-06-02');
    expect(payload.vendors).toHaveLength(1);
    const item = payload.vendors[0].items[0];
    // Case fields preserved (the spec-088 guard).
    expect(item.caseQty).toBe(24);
    expect(item.suggestedCases).toBe(3);
    expect(item.suggestedUnits).toBe(72);
    expect(item.estimatedCost).toBe(144);
    expect(item.flags).toEqual(['no_par']);
    expect(payload.kpis.totalEstimatedCost).toBe(144);
    expect(payload.warnings).toEqual([{ code: 'schedule_unknown', message: 'no schedule' }]);
  });

  // Spec 100 — the staff mapper carries the per-item `i18n_names` → `i18nNames`
  // (snake→camel) so the reorder screen can resolve names via getLocalizedName.
  // The admin db.ts copy intentionally does NOT — that asymmetry is by design.
  it('maps per-item i18n_names → i18nNames when present', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [
          {
            vendor_id: 'v-1',
            vendor_name: 'Tai Trading',
            items: [
              {
                item_id: 'i-1',
                item_name: 'Shrimp - Head Off',
                unit: 'CASE',
                i18n_names: { es: 'Camarón sin cabeza', 'zh-CN': '虾仁去头' },
              },
            ],
          },
        ],
        kpis: {},
        _warnings: [],
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.vendors[0].items[0].i18nNames).toEqual({
      es: 'Camarón sin cabeza',
      'zh-CN': '虾仁去头',
    });
  });

  it('coalesces a missing/null i18n_names to {} (pre-migration + no-override safe)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [
          {
            vendor_id: 'v-1',
            vendor_name: 'Tai Trading',
            items: [
              // No `i18n_names` key at all (pre-migration payload).
              { item_id: 'i-1', item_name: 'Buns', unit: 'each' },
              // Explicit null (catalog row has no overrides).
              { item_id: 'i-2', item_name: 'Salt', unit: 'oz', i18n_names: null },
            ],
          },
        ],
        kpis: {},
        _warnings: [],
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.vendors[0].items[0].i18nNames).toEqual({});
    expect(payload.vendors[0].items[1].i18nNames).toEqual({});
  });

  it('extracts the vendor name from a schedule_unknown warning message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [],
        kpis: {},
        _warnings: [
          {
            code: 'schedule_unknown',
            message: 'Vendor "Sysco Foods" has no order schedule — using 7-day buffer.',
          },
        ],
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.warnings).toEqual([
      {
        code: 'schedule_unknown',
        message: 'Vendor "Sysco Foods" has no order schedule — using 7-day buffer.',
        vendor: 'Sysco Foods',
      },
    ]);
  });

  it('omits `vendor` for non-schedule_unknown warnings', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [],
        kpis: {},
        _warnings: [{ code: 'some_other', message: 'Vendor "Acme" did a thing.' }],
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.warnings).toEqual([
      { code: 'some_other', message: 'Vendor "Acme" did a thing.' },
    ]);
    expect(payload.warnings[0]).not.toHaveProperty('vendor');
  });

  it('leaves `vendor` undefined when a schedule_unknown message has no quoted name', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [],
        kpis: {},
        _warnings: [{ code: 'schedule_unknown', message: 'no schedule' }],
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.warnings).toEqual([{ code: 'schedule_unknown', message: 'no schedule' }]);
    expect(payload.warnings[0]).not.toHaveProperty('vendor');
  });

  it('suggestedCases is null when the server returns null (no case size)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        vendors: [
          {
            vendor_id: 'v-1',
            items: [
              {
                item_id: 'i-1',
                item_name: 'Oil',
                unit: 'gal',
                suggested_qty: 8,
                case_qty: 1,
                suggested_cases: null,
                suggested_units: 8,
                estimated_cost: 8,
              },
            ],
          },
        ],
        kpis: {},
      },
      error: null,
    });
    const payload = await fetchStaffReorder('store-1', '2026-06-02');
    expect(payload.vendors[0].items[0].suggestedCases).toBeNull();
    expect(payload.vendors[0].items[0].caseQty).toBe(1);
  });

  it('throws (propagates) a PostgREST RLS error (42501) rather than swallowing', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied for function report_reorder_list' },
    });
    await expect(fetchStaffReorder('store-x', '2026-06-02')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('fetchStaffOrderSchedule', () => {
  function mockSelectChain(rows: unknown[], error: unknown = null) {
    const eq = jest.fn().mockResolvedValue({ data: rows, error });
    const select = jest.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });
    return { select, eq };
  }

  it('reads order_schedule for the store and maps to { [day]: OrderDayVendor[] }', async () => {
    const { select, eq } = mockSelectChain([
      { day_of_week: 'Monday', vendor_id: 'v-1', vendor_name: 'Acme', delivery_day: 'Wednesday' },
      { day_of_week: 'Monday', vendor_id: 'v-2', vendor_name: 'Beta', delivery_day: 'Thursday' },
      { day_of_week: 'Friday', vendor_id: 'v-3', vendor_name: 'Gamma', delivery_day: 'Monday' },
    ]);

    const schedule = await fetchStaffOrderSchedule('store-1');
    expect(mockFrom).toHaveBeenCalledWith('order_schedule');
    expect(select).toHaveBeenCalledWith('day_of_week, vendor_id, vendor_name, delivery_day');
    expect(eq).toHaveBeenCalledWith('store_id', 'store-1');

    expect(Object.keys(schedule).sort()).toEqual(['Friday', 'Monday']);
    expect(schedule.Monday).toHaveLength(2);
    expect(schedule.Monday[0]).toEqual({ vendorId: 'v-1', vendorName: 'Acme', deliveryDay: 'Wednesday' });
    expect(schedule.Friday[0]).toEqual({ vendorId: 'v-3', vendorName: 'Gamma', deliveryDay: 'Monday' });
  });

  it('skips rows with a null day_of_week', async () => {
    mockSelectChain([
      { day_of_week: null, vendor_id: 'v-1', vendor_name: 'Acme', delivery_day: 'Wednesday' },
      { day_of_week: 'Tuesday', vendor_id: 'v-2', vendor_name: 'Beta', delivery_day: 'Friday' },
    ]);
    const schedule = await fetchStaffOrderSchedule('store-1');
    expect(Object.keys(schedule)).toEqual(['Tuesday']);
  });

  it('throws on a PostgREST error', async () => {
    mockSelectChain([], { code: '42501', message: 'permission denied' });
    await expect(fetchStaffOrderSchedule('store-x')).rejects.toMatchObject({ code: '42501' });
  });
});
