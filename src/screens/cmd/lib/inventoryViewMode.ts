// src/screens/cmd/lib/inventoryViewMode.ts — Spec 142.
//
// Module-level persistence for the Inventory `viewMode` (items.tsv /
// catalog.tsv / categories). It survives the tier-change REMOUNT that
// ResponsiveCmdShell performs: the phone / tablet / desktop branches each mount
// `InventoryDesktopLayout` at a different position in their respective JSX
// trees, so React unmounts + remounts the body when the viewport crosses the
// 768 / 1100 breakpoints — which would otherwise reset `viewMode` (local
// useState) back to 'per-store' and make catalog-mode-on-phone (AC-INV5)
// unreachable on resize.
//
// This is deliberately a plain module singleton (not a store slice) — there is
// exactly one Inventory host mounted at a time, no cross-tab sync is wanted, and
// it must be readable synchronously at useState-initializer time. Tests reset it
// via `setLastInventoryViewMode('per-store')` in their setup.

export type InventoryViewMode = 'per-store' | 'catalog' | 'categories';

let last: InventoryViewMode = 'per-store';

export const getLastInventoryViewMode = (): InventoryViewMode => last;

export const setLastInventoryViewMode = (v: InventoryViewMode): void => {
  last = v;
};
