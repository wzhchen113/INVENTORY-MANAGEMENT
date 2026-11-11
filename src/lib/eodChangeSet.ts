// src/lib/eodChangeSet.ts — Spec 189 (design §5, D-4 on the client).
//
// Pure, dependency-free rules for what an admin EOD write sends. No React, no
// store, no `supabase` — a sibling of `eodCountMode.ts` / `eodNoNeed.ts` so the
// rules are a cheap jest unit surface.
//
// The server contract (`admin_submit_eod`) takes a set of CHANGED rows plus an
// explicit REMOVAL list. A row the call doesn't name is left exactly as it is,
// so deleting a count takes a positive statement that names it, and a client
// with stale state can only fail to touch rows (design §4). This module turns
// the worksheet's input maps plus a BASELINE (what the manager was shown and
// what is known to be saved) into that change set.
//
// "Blanked" vs "never touched" is told apart by the baseline: a row the
// manager was shown with a value and then cleared is removed; a row they never
// opened is not in the maps at all, or equals its baseline, and is skipped.
// Nothing here reads the category pill, so the RESULT covers the whole
// vendor's count whatever the pill (§12, D-4 first bullet).

import { eodRowCounted, eodRowEntryValues } from './eodNoNeed';
import type { EodCountMode } from './eodCountMode';

/** One row as the manager saw it, in the input maps' raw string form. */
export type EodRowSnapshot = { caseRaw: string; unitRaw: string; note: string; noNeed: boolean };

export interface EodChangeSetArgs {
  /** Store-scoped items. An id not in this list is skipped. */
  storeItems: ReadonlyArray<{ id: string; caseQty?: number | null }>;
  /** Rows known to be saved for (store, date, vendor), or undefined. */
  baseline: Record<string, EodRowSnapshot> | undefined;
  caseCounts: Record<string, string>;
  unitCounts: Record<string, string>;
  notes: Record<string, string>;
  noNeed: Record<string, boolean>;
  /** The item's LIVE effective EOD count mode. */
  modeOf: (itemId: string) => EodCountMode;
}

export interface EodChangeSet {
  changedItemIds: string[];
  removedItemIds: string[];
}

/** The current row, read from the vendor's input maps (absent key → ''/false). */
export function eodRowSnapshot(
  args: Pick<EodChangeSetArgs, 'caseCounts' | 'unitCounts' | 'notes' | 'noNeed'>,
  itemId: string,
): EodRowSnapshot {
  return {
    caseRaw: args.caseCounts[itemId] ?? '',
    unitRaw: args.unitCounts[itemId] ?? '',
    note: args.notes[itemId] ?? '',
    noNeed: args.noNeed[itemId] === true,
  };
}

export function sameEodRow(a: EodRowSnapshot, b: EodRowSnapshot): boolean {
  return a.caseRaw === b.caseRaw && a.unitRaw === b.unitRaw && a.note === b.note && a.noNeed === b.noNeed;
}

/**
 * Design §5 rule, per item, over the union of the vendor's map keys and the
 * baseline's keys:
 *
 *   item not in storeItems                          → skip
 *   baseline has the row, and current == baseline   → skip
 *   row has a value (eodRowEntryValues non-null)    → changed
 *   baseline has the row, row is blank, no NO NEED  → removed
 *   otherwise                                       → skip
 *
 * "Blank" means every ENABLED box trims to empty; an enabled box holding
 * unparseable text isn't blank (it has a value, total 0, as today).
 *
 * One guard on the removal arm, for a case the §5 tables don't cover: the
 * baseline row must itself have SHOWN a count under the live mode (a value in
 * an enabled box, or NO NEED). A saved value sitting only in a box the mode has
 * since disabled renders blank, so the manager can't have cleared it; editing
 * just that row's note must not delete the count (D-4: "never removes a count
 * the manager didn't clear"). Such a row is skipped and stays as saved.
 */
export function buildEodChangeSet(args: EodChangeSetArgs): EodChangeSet {
  const itemsById = new Map(args.storeItems.map((i) => [i.id, i]));
  const baseline = args.baseline ?? {};
  const ids = new Set<string>([
    ...Object.keys(args.caseCounts),
    ...Object.keys(args.unitCounts),
    ...Object.keys(args.notes),
    ...Object.keys(args.noNeed),
    ...Object.keys(baseline),
  ]);
  const changedItemIds: string[] = [];
  const removedItemIds: string[] = [];
  for (const id of ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const current = eodRowSnapshot(args, id);
    const base = Object.prototype.hasOwnProperty.call(baseline, id) ? baseline[id] : undefined;
    if (base && sameEodRow(current, base)) continue;
    const mode = args.modeOf(id);
    if (eodRowEntryValues(current.noNeed, mode, item.caseQty, current.caseRaw, current.unitRaw) !== null) {
      changedItemIds.push(id);
      continue;
    }
    if (base && !current.noNeed && eodRowCounted(base.noNeed, mode, base.caseRaw, base.unitRaw)) {
      removedItemIds.push(id);
    }
  }
  changedItemIds.sort();
  removedItemIds.sort();
  return { changedItemIds, removedItemIds };
}

/**
 * What a SUBMIT / SAVE DRAFT press does (design §5 "When the set is empty"):
 *
 *   empty → the existing "enter at least one" toast, no write
 *   noop  → no RPC, no optimistic writes, no audit, no bell; the normal success
 *           path with the saved row count
 *   ship  → write `itemIds` (built from the current maps) and `removedItemIds`
 *
 * | Change set                     | Situation                  | Result                  |
 * |--------------------------------|----------------------------|-------------------------|
 * | Empty                          | No baseline                | empty                   |
 * | Empty                          | Baseline, status unchanged | noop                    |
 * | Empty                          | Baseline, status changes   | ship the baseline rows  |
 * | Removes every baseline row,    |                            | empty                   |
 * | ships nothing                  |                            |                         |
 *
 * Shipping the baseline rows is the one place unchanged rows ship: the server
 * refuses an empty call (Rule A), so the status change needs a carrier. Only
 * baseline rows that still have a value under the live mode can carry it; if
 * none can, it's `empty`.
 */
export type EodSubmitPlan =
  | { kind: 'empty' }
  | { kind: 'noop' }
  | { kind: 'ship'; itemIds: string[]; removedItemIds: string[] };

export function planEodSubmit(args: EodChangeSetArgs & { statusChanges: boolean }): EodSubmitPlan {
  const { changedItemIds, removedItemIds } = buildEodChangeSet(args);
  const baselineIds = Object.keys(args.baseline ?? {});
  if (changedItemIds.length === 0 && removedItemIds.length === 0) {
    if (baselineIds.length === 0) return { kind: 'empty' };
    if (!args.statusChanges) return { kind: 'noop' };
    const itemsById = new Map(args.storeItems.map((i) => [i.id, i]));
    const carry = baselineIds
      .filter((id) => {
        const item = itemsById.get(id);
        if (!item) return false;
        const row = eodRowSnapshot(args, id);
        return eodRowEntryValues(row.noNeed, args.modeOf(id), item.caseQty, row.caseRaw, row.unitRaw) !== null;
      })
      .sort();
    return carry.length > 0 ? { kind: 'ship', itemIds: carry, removedItemIds: [] } : { kind: 'empty' };
  }
  if (changedItemIds.length === 0) {
    const removed = new Set(removedItemIds);
    if (baselineIds.every((id) => removed.has(id))) return { kind: 'empty' };
  }
  return { kind: 'ship', itemIds: changedItemIds, removedItemIds };
}
