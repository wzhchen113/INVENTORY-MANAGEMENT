// src/lib/uuid.ts — uuid v4 generator with a fallback for environments
// where `crypto.randomUUID` is unavailable.
//
// React Native 0.81 ships `crypto.randomUUID` via the Hermes engine
// globals (Expo SDK 54). On web, native crypto.randomUUID has been
// available in all modern browsers since 2022. Fallback is a
// Math.random()-based stub used ONLY for test environments (jest does
// not always expose crypto.randomUUID on jsdom < 20).
//
// Bounded in one file so swapping to a real uuid lib (if ever
// required) is a single-file change.

export function uuidv4(): string {
  // Prefer the platform's crypto.randomUUID — works on RN 0.81, web,
  // and node 18+ jest environments with --experimental-vm-modules.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback (rarely hit) — RFC 4122 §4.4 shape via Math.random.
  // Quality is fine for client-side dedup (server treats it as opaque).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
