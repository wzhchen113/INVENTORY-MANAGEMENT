// src/lib/eodDraftSlot.ts — Spec 192 (design §2).
//
// The one key format for the admin EOD worksheet's per-day draft state. Pure,
// dependency-free: no React, no store, no `supabase` — a sibling of
// `eodChangeSet.ts` / `eodNoNeed.ts` so jest can cover it cheaply.
//
// A SLOT is one (store, date, vendor). Spec 189's baseline was the first thing
// keyed this way (its `eodBaselineKey`, moved here and renamed `eodSlotKey`);
// spec 192 keys the typed case / unit values, notes, NO NEED marks and the EDIT
// flag the same way, so a value typed on one day can never be read, shown,
// gated, exported or submitted on another (spec 192 R1/R2).
//
// A DAY is one (store, date): the + COUNT rows and the completeness gate's
// local arms are day-scoped (R5, AC-4). A slot key is its day key plus
// `|${vendorId}`.
//
// Prefix safety: store and vendor ids are uuids and `dateIso` is a fixed
// `YYYY-MM-DD`, so none of them holds `|`. `isEodSlotOfDay` matches on the
// prefix `${storeId}|${dateIso}|` (trailing `|` included), which can't match
// another date, or a store whose id merely starts with this one's.
//
// If a future spec (185) adds an area dimension to the submission key, it
// changes here and nowhere else.

/** `${storeId}|${dateIso}` — + COUNT rows, and the gate's day filter. */
export function eodDayKey(storeId: string, dateIso: string): string {
  return `${storeId}|${dateIso}`;
}

/** `${storeId}|${dateIso}|${vendorId}` — spec 189's baseline key; the input maps and EDIT set use it too. */
export function eodSlotKey(storeId: string, dateIso: string, vendorId: string): string {
  return `${eodDayKey(storeId, dateIso)}|${vendorId}`;
}

/** True iff `slotKey` belongs to (storeId, dateIso). Prefix test on `${eodDayKey(...)}|`. */
export function isEodSlotOfDay(slotKey: string, storeId: string, dateIso: string): boolean {
  return slotKey.startsWith(`${eodDayKey(storeId, dateIso)}|`);
}
