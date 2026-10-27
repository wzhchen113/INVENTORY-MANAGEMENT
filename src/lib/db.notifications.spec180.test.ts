// src/lib/db.notifications.spec180.test.ts — spec 180 §5 / §8.2 (jest track).
//
// Pins the two db.ts helpers the EOD pop-up consumes:
//   • mapNotificationRow — the exported snake→camel mapper. It must carry the
//     new `submission_id` → `submissionId` (set only on 'eod_update' rows), and
//     a raw realtime `payload.new` row (no `reads` embed) must map `read: false`.
//   • markNotificationsRead — the bulk mark-read for a grouped pop-up click: an
//     empty list makes NO network call; otherwise ONE upsert into
//     notification_reads with `ignoreDuplicates` on (notification_id, user_id),
//     never sending user_id (the column defaults to auth.uid() server-side, and
//     sending someone else's would be the only way to hit the RLS check).
//
// Mocking strategy mirrors db.updateVendor.test.ts: one chainable builder per
// from(...); track(fn) runs the thunk directly with a dummy signal.

let upsertSpy: jest.Mock;
let abortSpy: jest.Mock;
let builder: any;

const mockFrom = jest.fn((table: string) => {
  if (table === 'notification_reads') return builder;
  throw new Error(`unexpected table in db.notifications.spec180 test: ${table}`);
});

jest.mock('./supabase', () => ({
  supabase: { from: (table: string) => mockFrom(table) },
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

import { mapNotificationRow, markNotificationsRead } from './db';

const baseRow = {
  id: 'n1',
  brand_id: 'b1',
  store_id: 's1',
  actor_user_id: 'u1',
  actor_name: 'maria',
  store_name: 'Towson',
  source_id: 'evt-1',
  created_at: '2026-10-26T22:00:00Z',
  category: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  upsertSpy = jest.fn().mockReturnThis();
  abortSpy = jest.fn().mockResolvedValue({ data: null, error: null });
  builder = { upsert: upsertSpy, abortSignal: abortSpy };
});

describe('mapNotificationRow (spec 180 §5)', () => {
  it('maps submission_id → submissionId on an eod_update row', () => {
    const n = mapNotificationRow({
      ...baseRow,
      type: 'eod_update',
      submission_id: 'sub-9',
      body: 'Sysco',
    });
    expect(n).toEqual({
      id: 'n1',
      brandId: 'b1',
      storeId: 's1',
      actorUserId: 'u1',
      actorName: 'maria',
      storeName: 'Towson',
      type: 'eod_update',
      sourceId: 'evt-1',
      createdAt: '2026-10-26T22:00:00Z',
      read: false,
      body: 'Sysco',
      category: undefined,
      submissionId: 'sub-9',
    });
  });

  it('maps a raw realtime row (no reads embed) to read: false', () => {
    expect(mapNotificationRow({ ...baseRow, type: 'eod' }).read).toBe(false);
  });

  it('maps an embedded read row to read: true (feed path unchanged)', () => {
    expect(
      mapNotificationRow({ ...baseRow, type: 'eod', reads: [{ read_at: 'x' }] }).read,
    ).toBe(true);
  });

  it('defaults submissionId to null when the column is absent or NULL', () => {
    expect(mapNotificationRow({ ...baseRow, type: 'eod' }).submissionId).toBeNull();
    expect(
      mapNotificationRow({ ...baseRow, type: 'order_ready', submission_id: null }).submissionId,
    ).toBeNull();
  });
});

describe('markNotificationsRead (spec 180 §5)', () => {
  it('resolves without any network call for an empty list', async () => {
    await expect(markNotificationsRead([])).resolves.toBeUndefined();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('sends ONE idempotent upsert with one row per id and no user_id', async () => {
    await markNotificationsRead(['n1', 'n2', 'n3']);

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('notification_reads');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      [{ notification_id: 'n1' }, { notification_id: 'n2' }, { notification_id: 'n3' }],
      { onConflict: 'notification_id,user_id', ignoreDuplicates: true },
    );
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('warns and throws on a backend error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const err = { message: 'boom', code: '42501' };
    abortSpy.mockResolvedValueOnce({ data: null, error: err });

    await expect(markNotificationsRead(['n1'])).rejects.toBe(err);
    expect(warn).toHaveBeenCalledWith('[Supabase] markNotificationsRead:', 'boom');
    warn.mockRestore();
  });
});
