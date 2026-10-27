// src/lib/uuid.test.ts — Spec 181 §5.1 / §9 (AC-10 / AC-11 core).
//
// The shared Hermes-safe v4 minter. Each tier is exercised by swapping
// `globalThis.crypto` (Hermes ships neither randomUUID nor getRandomValues, so
// the `undefined` case is the native path).

import { uuidv4 } from './uuid';
import { uuidv4 as staffUuidv4 } from '../screens/staff/lib/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function setCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

afterEach(() => {
  if (realCrypto) {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  } else {
    delete (globalThis as { crypto?: unknown }).crypto;
  }
});

describe('uuidv4 (spec 181)', () => {
  it('crypto undefined (Hermes) → still a valid RFC-4122 v4 string', () => {
    setCrypto(undefined);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = uuidv4();
      expect(id).toMatch(V4);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it('only getRandomValues → v4 with the version nibble and variant bits forced', () => {
    // All-0xff bytes: without masking, the version/variant positions would be
    // `f`, so this proves the masks are applied.
    const getRandomValues = jest.fn((arr: Uint8Array) => {
      arr.fill(0xff);
      return arr;
    });
    setCrypto({ getRandomValues });
    const id = uuidv4();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(id).toMatch(V4);
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');

    // All-zero bytes → version 4, variant 8.
    getRandomValues.mockImplementation((arr: Uint8Array) => {
      arr.fill(0);
      return arr;
    });
    expect(uuidv4()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('randomUUID present → delegates to it', () => {
    const randomUUID = jest.fn(() => '11111111-2222-4333-8444-555555555555');
    const getRandomValues = jest.fn();
    setCrypto({ randomUUID, getRandomValues });
    expect(uuidv4()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('the staff subtree re-exports the same helper', () => {
    expect(staffUuidv4).toBe(uuidv4);
  });
});
