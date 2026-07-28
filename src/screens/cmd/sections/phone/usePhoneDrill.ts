// src/screens/cmd/sections/phone/usePhoneDrill.ts
//
// Spec 142 §2 (AC-D1/D2) — the tiny selection-state hook behind the shared
// phone drill-in scaffold. Generalizes the Brands `isCompact && showDetail`
// idiom (BrandsSection.tsx:225) into one reusable piece so the six list/detail
// sections in scope share ONE scaffold rather than hand-rolling their own.
//
// Nothing is selected by default (AC-D2 / Hard Rule 7): the list opens with no
// detail shown; a detail exists only after the user taps a row.

import { useCallback, useState } from 'react';

export interface PhoneDrill<T> {
  /** The currently drilled-into row, or null when the list-only view is shown. */
  selected: T | null;
  /** True iff a detail is open (selected !== null). */
  isDetail: boolean;
  /** Open the full-screen detail for a row. */
  open: (item: T) => void;
  /** Return to the list (clears the selection). */
  close: () => void;
}

export function usePhoneDrill<T extends { id: string }>(): PhoneDrill<T> {
  const [selected, setSelected] = useState<T | null>(null);
  const open = useCallback((item: T) => setSelected(item), []);
  const close = useCallback(() => setSelected(null), []);
  return { selected, isDetail: selected !== null, open, close };
}
