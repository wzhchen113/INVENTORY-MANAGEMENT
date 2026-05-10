// src/lib/posBreadbot.ts
//
// Shared constants + helpers for the Breadbot POS-import flow. Consumed
// by the legacy `src/screens/POSImportScreen.tsx` and the new Cmd UI
// section `src/screens/cmd/sections/POSImportsSection.tsx`. Extracted
// per spec 014 design (architect Q1) so the two surfaces don't drift
// while the legacy screen is being phased out.
//
// Backend touch-points (do not change here — see db.ts and the edge
// function for the data path):
//   - fetchBreadbotSales(storeName, date)  → src/lib/db.ts:907
//   - hasPOSImportForDate(storeId, date)   → src/lib/db.ts:869
//   - savePOSImport(...)                   → src/lib/db.ts:831
//   - importPOS({...}) action              → src/store/useStore.ts:1390
//
// Pure module — no React, no Supabase imports — safe to use from any
// surface (Cmd section, legacy screen, future utilities).

// ── Stores Breadbot has data for ────────────────────────────────────────
// Mirror of STORE_MAP in supabase/functions/fetch-breadbot-sales/index.ts.
// The edge function is the source of truth; this set is the UI guard so
// the FETCH BREADBOT button is only shown for stores Breadbot can serve.
// Renaming a store in the `stores` table will silently hide the button —
// out of scope to fix here (same risk exists in legacy).
export const BREADBOT_STORES: ReadonlySet<string> = new Set([
  'Frederick',
  'Charles',
  'Towson',
]);

// ── Range backfill bounds ──────────────────────────────────────────────
// Cap on a single backfill window. Keeps the loop bounded and the
// throttled request stream well under Breadbot's 60/min documented rate
// limit.
export const BACKFILL_MAX_DAYS = 30;

// Sleep between per-day fetches inside a backfill loop. ~5 req/s.
export const BACKFILL_THROTTLE_MS = 200;

// ── Per-day backfill outcome ──────────────────────────────────────────
// Surface row for the post-backfill summary card. Match the legacy
// shape (`POSImportScreen.tsx:39-45`) so both surfaces render the same
// data structure.
export type BackfillResult = {
  date: string;
  outcome: 'imported' | 'skipped' | 'failed';
  reason?: string;
  itemCount?: number;
};

// Enumerate YYYY-MM-DD strings inclusive of both ends, using UTC math
// so DST transitions don't drop or duplicate a day at the boundary.
// Ported verbatim from legacy POSImportScreen.tsx:52-63.
export function enumerateDates(start: string, end: string): string[] {
  if (start > end) return [];
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    const [y, m, d] = cur.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    cur = next.toISOString().split('T')[0];
  }
  return out;
}

// Today as a YYYY-MM-DD string in the user's local time. Matches the
// legacy helper at POSImportScreen.tsx:90-93 — uses local components on
// purpose so the default in the UI matches the date label the user sees
// on their wall clock.
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
