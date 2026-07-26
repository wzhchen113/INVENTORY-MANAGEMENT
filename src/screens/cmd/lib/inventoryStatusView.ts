// src/screens/cmd/lib/inventoryStatusView.ts
//
// Pure helper for the items.tsv stock-status quick-filter (2026-07 owner ask —
// "a sorted press by out / low / ok, easier to view what's out of stock").
//
// Takes the already text-filtered rows plus a status accessor and produces
//   • `counts`  — per-status badge numbers for the chips (over ALL input rows,
//                 so a count stays stable as the user toggles between chips);
//   • `items`   — the rows narrowed to the active status chip (null = all) and
//                 sorted by stock URGENCY first (out → low → ok) then by the
//                 caller-supplied display name, so what needs attention floats
//                 to the top even in the "All" view.
//
// Framework-free (no React / theme / store) so it unit-tests without a mount.

import type { ItemStatus } from '../../../types';

// out first, then low, then ok — most-urgent at the top of the list.
const STATUS_RANK: Record<ItemStatus, number> = { out: 0, low: 1, ok: 2 };

export interface StatusView<T> {
  counts: Record<ItemStatus, number>;
  items: T[];
}

export function applyInventoryStatusView<T>(
  rows: T[],
  getStatus: (row: T) => ItemStatus,
  statusFilter: ItemStatus | null,
  displayName: (row: T) => string,
  locale: string,
): StatusView<T> {
  const counts: Record<ItemStatus, number> = { out: 0, low: 0, ok: 0 };
  for (const r of rows) counts[getStatus(r)] += 1;

  const items = rows
    .filter((r) => !statusFilter || getStatus(r) === statusFilter)
    .slice()
    .sort((a, b) => {
      const ra = STATUS_RANK[getStatus(a)];
      const rb = STATUS_RANK[getStatus(b)];
      if (ra !== rb) return ra - rb;
      return displayName(a).localeCompare(displayName(b), locale);
    });

  return { counts, items };
}
