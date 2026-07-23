import { create } from 'zustand';

// Spec 137 — cross-tab deep-link signal for the unified "Ordering" destination.
//
// When "+ CREATE PO" succeeds on the Reorder tab, the OrderingSection shell
// flips to the Purchase-orders tab (plain shell state) AND writes the new
// draft's poId here. POsSection subscribes and one-shot selects that PO, then
// consumes the signal.
//
// This is a dedicated ~30-line Zustand signal — deliberately NOT overloaded
// onto `paletteAction.ts` (the ⌘K/section-nav bridge), which already couples
// the shell and InventoryDesktopLayout on `section` + `selectedName` timing.
// Mirrors the paletteAction.ts precedent: a tiny, single-concern store.
//
// Payload is a single `poId` string — no section/tab data. The shell owns the
// tab flip; this signal only carries the PO to preselect.

interface OrderingHandoffState {
  pendingPoId: string | null;
  requestPoSelect: (poId: string) => void;
  consume: () => void;
}

export const useOrderingHandoff = create<OrderingHandoffState>((set) => ({
  pendingPoId: null,
  requestPoSelect: (poId) => set({ pendingPoId: poId }),
  consume: () => set({ pendingPoId: null }),
}));
