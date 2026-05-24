// src/lib/eodQueue.test.ts — hydrate / push / drain / corrupt-payload.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  QUEUE_KEY,
  ACTIVE_STORE_KEY,
  clearQueue,
  drainQueue,
  hydrateQueue,
  peekQueue,
  persistQueue,
  pushQueueItem,
  readActiveStoreId,
  writeActiveStoreId,
} from './eodQueue';
import type { QueuedSubmission } from './types';

function makeItem(overrides: Partial<QueuedSubmission> = {}): QueuedSubmission {
  return {
    client_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    store_id: 'store-1',
    date: '2026-05-24',
    vendor_id: 'vendor-1',
    status: 'submitted',
    entries: [{ item_id: 'item-1', count: 5 }],
    queued_at: new Date().toISOString(),
    intent_user_id: 'user-1',
    attempts: 0,
    ...overrides,
  };
}

describe('eodQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('hydrateQueue', () => {
    it('returns [] when storage is empty', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const out = await hydrateQueue();
      expect(out).toEqual([]);
    });

    it('returns the parsed array when storage has valid JSON', async () => {
      const item = makeItem();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify([item]));
      const out = await hydrateQueue();
      expect(out).toHaveLength(1);
      expect(out[0].client_uuid).toBe(item.client_uuid);
    });

    it('backs up corrupt JSON to :v1-corrupted and returns []', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('{not-json');
      const out = await hydrateQueue();
      expect(out).toEqual([]);
      // Backup write fired with the raw bytes
      const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const backup = setItemCalls.find(([k]) => String(k).startsWith(`${QUEUE_KEY}-corrupted`));
      expect(backup).toBeDefined();
      expect(backup?.[1]).toBe('{not-json');
      // Original key removed
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    });

    it('backs up non-array payload and returns []', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('{"not":"array"}');
      const out = await hydrateQueue();
      expect(out).toEqual([]);
      const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const backup = setItemCalls.find(([k]) => String(k).startsWith(`${QUEUE_KEY}-corrupted`));
      expect(backup).toBeDefined();
    });

    it('drops malformed items but keeps valid ones', async () => {
      const valid = makeItem();
      const malformed = { not: 'a-queued-submission' };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify([valid, malformed]),
      );
      const out = await hydrateQueue();
      expect(out).toHaveLength(1);
      expect(out[0].client_uuid).toBe(valid.client_uuid);
    });

    it('GCs items older than 30 days', async () => {
      const fresh = makeItem({
        client_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        queued_at: new Date().toISOString(),
      });
      const stale = makeItem({
        client_uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        queued_at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(),
      });
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify([fresh, stale]),
      );
      const out = await hydrateQueue();
      expect(out).toHaveLength(1);
      expect(out[0].client_uuid).toBe(fresh.client_uuid);
    });
  });

  describe('pushQueueItem', () => {
    it('appends to the existing array and persists', async () => {
      const a = makeItem();
      const b = makeItem({ client_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      const next = await pushQueueItem([a], b);
      expect(next).toHaveLength(2);
      expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(QUEUE_KEY, JSON.stringify([a, b]));
    });
  });

  describe('peekQueue', () => {
    it('delegates to hydrate', async () => {
      const item = makeItem();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify([item]));
      const out = await peekQueue();
      expect(out).toHaveLength(1);
    });
  });

  describe('drainQueue', () => {
    it('removes successful items from the queue and persists', async () => {
      const a = makeItem();
      const b = makeItem({ client_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      const submitOne = jest.fn().mockResolvedValue('success');
      const { remaining, forbiddenItems } = await drainQueue([a, b], submitOne);
      expect(remaining).toEqual([]);
      expect(forbiddenItems).toEqual([]);
      expect(submitOne).toHaveBeenCalledTimes(2);
    });

    it('removes forbidden items and surfaces them', async () => {
      const a = makeItem();
      const submitOne = jest.fn().mockResolvedValue('forbidden');
      const { remaining, forbiddenItems } = await drainQueue([a], submitOne);
      expect(remaining).toEqual([]);
      expect(forbiddenItems).toHaveLength(1);
    });

    it('leaves network-error items in queue, bumps attempts, stops draining', async () => {
      const a = makeItem({ attempts: 0 });
      const b = makeItem({ client_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      const submitOne = jest
        .fn()
        .mockResolvedValueOnce('network')
        .mockResolvedValue('success');
      const { remaining } = await drainQueue([a, b], submitOne);
      expect(remaining).toHaveLength(2); // network → break, so b stays too
      expect(remaining[0].attempts).toBe(1); // a's attempts bumped
      expect(submitOne).toHaveBeenCalledTimes(1); // halted after first network failure
    });
  });

  describe('persistQueue / clearQueue', () => {
    it('writes the JSON to storage', async () => {
      await persistQueue([makeItem()]);
      expect(AsyncStorage.setItem).toHaveBeenCalled();
    });
    it('removes the queue key on clearQueue', async () => {
      await clearQueue();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    });
  });

  describe('active store persistence', () => {
    it('reads / writes the active store id', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('store-x');
      const got = await readActiveStoreId();
      expect(got).toBe('store-x');
      await writeActiveStoreId('store-y');
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(ACTIVE_STORE_KEY, 'store-y');
    });
    it('removes the key when value is null', async () => {
      await writeActiveStoreId(null);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(ACTIVE_STORE_KEY);
    });
  });
});
