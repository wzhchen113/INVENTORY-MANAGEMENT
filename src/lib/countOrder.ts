// src/lib/countOrder.ts — Spec 103.
//
// Shared, dependency-free PURE module for the per-user custom count-screen
// order. No `supabase`, no React, no store — so BOTH the admin path (db.ts) and
// the staff-subtree carve-out (src/screens/staff/lib/countOrder.ts) import it
// without violating the spec-063 carve-out (which is about `supabase.from/rpc`
// call sites, not pure helpers). Centralizing the only testable logic here is
// what keeps the two duplicated thin I/O paths byte-aligned (design §5 / §14).
//
// The two functions are the unit-test surface for AC-3 (round-trip apply),
// AC-9 (render-only — apply is independent of the submission scope), and AC-12
// (gate jump resolves "first uncounted" against the user's CURRENT on-screen
// order).

// ─── Screen keys (OQ-7) ──────────────────────────────────────
// The four stable `screen` identifiers, exported so call sites don't
// stringly-type the key. These MUST match the CHECK constraint on
// public.user_count_orders.screen (migration 20260630000500_user_count_orders).
export type CountOrderScreen =
  | 'admin-eod'
  | 'admin-inventory'
  | 'staff-eod'
  | 'staff-weekly';

/**
 * Apply a saved sparse order to the current item set (OQ-3).
 *
 * Ordering rules (a stable partition):
 *   1. Items present in `savedIds` come FIRST, in `savedIds` order.
 *   2. Items NOT in `savedIds` (new / never-placed) come AFTER, in their
 *      default (input) relative order.
 *   3. Ids in `savedIds` that reference an item NOT in `items` (deleted /
 *      removed from the store) are ignored.
 *
 * Pure + total. A null/undefined/empty `savedIds` yields the input order
 * unchanged (identity in default order) — i.e. "no custom order" renders the
 * screen's default. Duplicate ids in `savedIds` are de-duplicated (first
 * occurrence wins); the function never emits an item twice and never drops an
 * input item (AC-14: an unranked item never silently disappears).
 *
 * Render-only: this is NEVER the submission source. Callers keep iterating the
 * full item set for `buildSubmission` / the entry-builder (AC-9). It only
 * re-points the render list and the gate's "first" resolution (see
 * `firstUncounted`).
 */
export function applyCountOrder<T>(
  items: readonly T[],
  savedIds: readonly string[] | null | undefined,
  idOf: (item: T) => string,
): T[] {
  // Fast path: no saved order → input order verbatim (a fresh array copy so
  // callers never alias the source). Also covers the "user never reordered"
  // and "reset to default" states.
  if (!savedIds || savedIds.length === 0) {
    return items.slice();
  }

  // Index the current items by id for O(1) lookup. A Map (not a plain object)
  // so non-string-safe ids never collide with prototype keys.
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = idOf(item);
    // First-wins on a duplicate id in the input (defensive; ids are expected
    // unique). Keeps the partition deterministic.
    if (!byId.has(id)) byId.set(id, item);
  }

  const ranked: T[] = [];
  const placed = new Set<string>();

  // Pass 1 — ranked items, in savedIds order. Skip ids whose item is gone
  // (deleted) and skip duplicate savedIds (first occurrence wins).
  for (const id of savedIds) {
    if (placed.has(id)) continue;
    const item = byId.get(id);
    if (item === undefined) continue; // deleted id — ignored (OQ-3)
    ranked.push(item);
    placed.add(id);
  }

  // Pass 2 — unranked tail, in the input's default relative order. Any input
  // item whose id was not placed by pass 1 appends here (OQ-3 / AC-14).
  const tail: T[] = [];
  for (const item of items) {
    if (!placed.has(idOf(item))) tail.push(item);
  }

  return ranked.concat(tail);
}

/**
 * Resolve "first uncounted in the user's CURRENT on-screen order" (AC-12).
 *
 * The caller passes the ALREADY-ORDERED list — the custom order when Custom
 * view is active (`applyCountOrder(fullItems, savedIds, idOf)`), else the
 * screen's default order — and an `isCounted` predicate. Returns the first item
 * for which `isCounted` is false, or `null` when every item is counted.
 *
 * Pure + total. The list passed MUST be the FULL item set (not the
 * search-narrowed view) so the gate's jump lands on the topmost uncounted row
 * as the user sees them top-to-bottom — matching today's clear-search-then-jump
 * behavior on the three gated screens (admin EOD, staff EOD, staff Weekly).
 * Admin Inventory has no gate and does not use this.
 */
export function firstUncounted<T>(
  orderedItems: readonly T[],
  isCounted: (item: T) => boolean,
): T | null {
  for (const item of orderedItems) {
    if (!isCounted(item)) return item;
  }
  return null;
}

/**
 * Move the item at `index` by `delta` (±1) and return the NEW id order, or
 * `null` when the move is a no-op (the target index is out of bounds — i.e.
 * nudging the first row up or the last row down).
 *
 * This is the only hand-rolled reorder math behind the native ▲/▼ "move"
 * affordance (the web @dnd-kit path uses the library's own `arrayMove`). It is
 * shared by BOTH the admin and staff `CountOrderDragList` wrappers so the
 * native fallback produces the SAME id order the web drag would — and so the
 * single jest unit (`CountOrderDragList.nudge.test.tsx`) covers both. Pure +
 * total; never mutates `ids` (returns a fresh array).
 */
export function nudge(
  ids: readonly string[],
  index: number,
  delta: number,
): string[] | null {
  const target = index + delta;
  if (target < 0 || target >= ids.length) return null;
  const next = ids.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}
