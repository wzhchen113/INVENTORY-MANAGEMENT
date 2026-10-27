// src/lib/uuid.ts — Spec 181 §5.1. The ONE RFC-4122 v4 UUID minter for
// client-side idempotency keys (`client_uuid` / `clientUuid`).
//
// Hermes (React Native 0.81 / Expo SDK 54) ships NEITHER
// `crypto.randomUUID` NOR `crypto.getRandomValues`, so the old inline
// `crypto.randomUUID ? … : 'cu-<ts>-…'` fallbacks minted non-UUID strings on
// native and the `uuid`-typed RPC params (`submit_inventory_count`,
// `receive_purchase_order`) rejected them. This helper always returns a
// valid v4 string:
//
//   1. `globalThis.crypto.randomUUID` when present (web, Node/jest);
//   2. else `globalThis.crypto.getRandomValues` with the version nibble
//      forced to 4 and the variant bits to 10xx;
//   3. else a `Math.random` template — this is the branch that runs on
//      Hermes. The value is an opaque idempotency/dedup key, not a secret,
//      so a non-CSPRNG source is acceptable (status quo for staff EOD since
//      spec 063). Upgrading to a CSPRNG later is a change to this file only.
//
// Pure TS, no imports — safe to re-export from the staff subtree
// (src/screens/staff/lib/uuid.ts) without pulling in the admin store.

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

export function uuidv4(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    let hex = '';
    for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  }

  // RFC 4122 §4.4 shape via Math.random (Hermes path).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
