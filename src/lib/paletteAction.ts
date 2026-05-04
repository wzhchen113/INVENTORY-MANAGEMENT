import { create } from 'zustand';

// Bridge between CmdPaletteHost and InventoryDesktopLayout (and any future
// desktop section that wants to react to ⌘K results). On desktop, palette
// navigation can't use react-navigation routes the way mobile does — the
// whole desktop is a single screen with local section + selection state.
// So the palette writes a pending action here, the desktop layout reads it
// and applies it once.

interface PendingAction {
  section: string;
  selectedName: string | null; // lowercase — matches InventoryDesktopLayout's keying
  // When set together with section='EODCount', EODCountSection adds the item
  // to its worksheet and focuses the count input. Used by the inventory-detail
  // "+ COUNT" button to take the user to a pre-loaded worksheet.
  eodFocusItemId?: string;
}

interface State {
  pending: PendingAction | null;
  request: (a: PendingAction) => void;
  consume: () => void;
}

export const usePaletteAction = create<State>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  consume: () => set({ pending: null }),
}));
