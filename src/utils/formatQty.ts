// src/utils/formatQty.ts — extracted from reorderExport.ts so DEPENDENCY-FREE
// consumers (poQuickOrderText.ts and, through it, the extension/ bundle's
// Track 1c isolated typecheck) don't drag reorderExport's papaparse import
// into their TS program. reorderExport re-exports this for its existing
// importers — ONE implementation, same bytes.
export function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Match the units / variance runners' shape: drop trailing zeros but
  // keep up to 2 decimals.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}
