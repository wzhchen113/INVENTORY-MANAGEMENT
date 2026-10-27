// src/lib/countDraftLocal.test.ts — Spec 181 (B2 / AC-13).
//
// `loadLocalCountDraft` — the async, platform-agnostic read the
// InventoryCountSection restore paths use. On native it reads AsyncStorage
// (global official mock in tests/jest.setup.ts) under the SAME key
// `writeLocalCountDraft` writes; on web it delegates to the sync localStorage
// read. Never rejects.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  countDraftLocalKey,
  loadLocalCountDraft,
  writeLocalCountDraft,
  type LocalCountDraft,
} from './countDraftLocal';

const ORIGINAL_OS = Platform.OS;
function setPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

const RECORD: LocalCountDraft = {
  payload: { v: 1, kind: 'open', unitCounts: { 'item-1': '3' } },
  savedAt: '2026-10-26T12:00:00.000Z',
  unsynced: true,
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

afterEach(() => {
  setPlatform(ORIGINAL_OS);
});

describe('loadLocalCountDraft — native (AsyncStorage)', () => {
  beforeEach(() => setPlatform('ios'));

  it('returns a record seeded under imr.countDraft.admin-inventory.<storeId>.<userId>', async () => {
    await AsyncStorage.setItem(
      'imr.countDraft.admin-inventory.store-1.user-1',
      JSON.stringify(RECORD),
    );
    expect(countDraftLocalKey('user-1', 'admin-inventory', 'store-1')).toBe(
      'imr.countDraft.admin-inventory.store-1.user-1',
    );
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toEqual(RECORD);
  });

  it('reads back what writeLocalCountDraft wrote (shared key builder)', async () => {
    writeLocalCountDraft('user-2', 'admin-inventory', 'store-9', RECORD);
    // The native write is fire-and-forget; let the mock's promise settle.
    await new Promise((r) => setTimeout(r, 0));
    await expect(loadLocalCountDraft('user-2', 'admin-inventory', 'store-9')).resolves.toEqual(RECORD);
  });

  it('miss → null', async () => {
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });

  it('malformed JSON → null', async () => {
    await AsyncStorage.setItem('imr.countDraft.admin-inventory.store-1.user-1', '{not json');
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });

  it('wrong shape → null', async () => {
    await AsyncStorage.setItem(
      'imr.countDraft.admin-inventory.store-1.user-1',
      JSON.stringify({ hello: 'world' }),
    );
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });

  it('getItem rejects → null (never rejects)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk gone'));
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });

  it('getItem throws synchronously → null (never rejects)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });
});

describe('loadLocalCountDraft — web (localStorage)', () => {
  const realWindow = (global as { window?: unknown }).window;
  let store: Record<string, string>;

  beforeEach(() => {
    setPlatform('web');
    store = {};
    (global as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
    };
  });

  afterEach(() => {
    (global as { window?: unknown }).window = realWindow;
  });

  it('delegates to the synchronous localStorage read and never touches AsyncStorage', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem');
    spy.mockClear(); // the official mock's getItem is a shared jest.fn
    store['imr.countDraft.admin-inventory.store-1.user-1'] = JSON.stringify(RECORD);
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toEqual(RECORD);
    expect(spy).not.toHaveBeenCalled();
  });

  it('web miss → null', async () => {
    await expect(loadLocalCountDraft('user-1', 'admin-inventory', 'store-1')).resolves.toBeNull();
  });
});
