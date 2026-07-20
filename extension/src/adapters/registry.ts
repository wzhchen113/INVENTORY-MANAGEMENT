// Spec 132 — adapter registry. Maps a site origin to its vendor adapter. The
// vendor↔PO join is by order_page_url origin (core/origin.ts); THIS map picks
// the DOM adapter for the origin the admin is currently on. Only the two
// host-permitted origins resolve (AC-1) — anything else → null.

import { bjsAdapter } from './bjs';
import { samsClubAdapter } from './samsclub';
import type { VendorAdapter } from './types';

export const ADAPTERS: VendorAdapter[] = [bjsAdapter, samsClubAdapter];

/** The adapter that owns `origin`, or null if none (AC-1 — scoped to two sites). */
export function adapterForOrigin(origin: string): VendorAdapter | null {
  return ADAPTERS.find((a) => a.matchesOrigin(origin)) ?? null;
}
