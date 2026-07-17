// src/screens/staff/lib/itemsUpdated.test.ts — spec 128.
//
// The staff "Updated" badge data carve-out. Mocks the supabase.rpc boundary →
// asserts the staff_items_updated RPC call shape, the Set-of-updated-ids
// projection (only rows with updated === true), and the best-effort degrade
// (an RPC error or a thrown call resolves to an EMPTY set, never rejects, so a
// badge-fetch failure can't block the count screen).

const mockRpc = jest.fn();

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

// Silence + observe the best-effort error sink.
jest.mock('./notifyBackendError', () => ({
  notifyBackendError: jest.fn(),
}));

import { fetchUpdatedItemIds } from './itemsUpdated';
import { notifyBackendError } from './notifyBackendError';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fetchUpdatedItemIds', () => {
  it('calls staff_items_updated with p_store_id', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await fetchUpdatedItemIds('store-1');
    expect(mockRpc).toHaveBeenCalledWith('staff_items_updated', {
      p_store_id: 'store-1',
    });
  });

  it('returns a Set of item_ids where updated === true (dropping false/absent)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        { item_id: 'i-1', updated: true },
        { item_id: 'i-2', updated: false },
        { item_id: 'i-3', updated: true },
        { item_id: 'i-4' }, // no `updated` key → not included
      ],
      error: null,
    });
    const set = await fetchUpdatedItemIds('store-1');
    expect(set).toBeInstanceOf(Set);
    expect([...set].sort()).toEqual(['i-1', 'i-3']);
    expect(set.has('i-2')).toBe(false);
    expect(set.has('i-4')).toBe(false);
  });

  it('returns an empty Set when the RPC yields no rows', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const set = await fetchUpdatedItemIds('store-1');
    expect(set.size).toBe(0);
  });

  it('swallows a PostgREST error to an empty Set (best-effort — never rejects)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    });
    const set = await fetchUpdatedItemIds('store-x');
    expect(set.size).toBe(0);
    expect(notifyBackendError).toHaveBeenCalledWith('fetchUpdatedItemIds', expect.anything());
  });

  it('swallows a thrown/rejected call to an empty Set', async () => {
    mockRpc.mockRejectedValueOnce(new Error('network down'));
    const set = await fetchUpdatedItemIds('store-1');
    expect(set.size).toBe(0);
    expect(notifyBackendError).toHaveBeenCalled();
  });

  it('tolerates a non-array data payload (returns empty Set)', async () => {
    // e.g. a shared rpc-mock that hands back some other RPC's object envelope.
    mockRpc.mockResolvedValueOnce({ data: { items: [] }, error: null });
    const set = await fetchUpdatedItemIds('store-1');
    expect(set.size).toBe(0);
  });
});
