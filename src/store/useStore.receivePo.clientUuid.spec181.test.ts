// src/store/useStore.receivePo.clientUuid.spec181.test.ts — Spec 181 (C4 / AC-11).
//
// `receivePurchaseOrder` used to fall back to a non-UUID `rcv-<ts>-…` key when
// `crypto.randomUUID` was missing — which is ALWAYS the case on Hermes — and the
// `uuid`-typed `p_client_uuid` RPC param rejected it. With `globalThis.crypto`
// undefined (simulating Hermes) the key handed to db.receivePurchaseOrder must
// be a real RFC-4122 v4 string.
//
// Mocking follows useStore.createPoDraft.spec125.test.ts. db.receivePurchaseOrder
// resolves null so the action returns before its refresh chain (that chain is
// not under test here).

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  receivePurchaseOrder: jest.fn().mockResolvedValue(null),
}));

import * as db from '../lib/db';
import { useStore } from './useStore';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const receiveMock = db.receivePurchaseOrder as jest.Mock;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeEach(() => {
  receiveMock.mockClear();
});

afterEach(() => {
  if (realCrypto) {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  } else {
    delete (globalThis as { crypto?: unknown }).crypto;
  }
});

describe('receivePurchaseOrder clientUuid (spec 181 C4)', () => {
  it('with globalThis.crypto undefined (Hermes) passes a v4 UUID as arg 3', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const lines = [{ poItemId: 'line-1', receivedQty: 2 }];
    await useStore.getState().receivePurchaseOrder('po-1', lines);

    expect(receiveMock).toHaveBeenCalledTimes(1);
    const [poId, passedLines, clientUuid] = receiveMock.mock.calls[0];
    expect(poId).toBe('po-1');
    expect(passedLines).toBe(lines);
    expect(clientUuid).toMatch(V4);
    expect(String(clientUuid).startsWith('rcv-')).toBe(false);
  });

  it('mints a fresh key per receive event', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await useStore.getState().receivePurchaseOrder('po-1', []);
    await useStore.getState().receivePurchaseOrder('po-1', []);
    const a = receiveMock.mock.calls[0][2];
    const b = receiveMock.mock.calls[1][2];
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });

  it('with crypto.randomUUID present, still a v4 UUID', async () => {
    await useStore.getState().receivePurchaseOrder('po-2', []);
    expect(receiveMock.mock.calls[0][2]).toMatch(V4);
  });
});
