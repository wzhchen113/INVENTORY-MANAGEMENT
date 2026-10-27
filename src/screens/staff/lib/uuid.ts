// src/screens/staff/lib/uuid.ts — staff-local barrel for the shared UUID
// minter (spec 181 §5.1).
//
// The implementation lives in `src/lib/uuid.ts` (pure TS, no imports), so the
// staff subtree and the admin Cmd UI mint idempotency keys from ONE helper —
// the same re-export-of-pure idiom as `./eodCountMode.ts` and `./countOrder.ts`.
// Note: Hermes (RN 0.81 / Expo SDK 54) does NOT ship `crypto.randomUUID` or
// `crypto.getRandomValues`; the shared helper falls back to a Math.random v4
// template on native, which is fine for an opaque client-side dedup key.

export { uuidv4 } from '../../../lib/uuid';
