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
