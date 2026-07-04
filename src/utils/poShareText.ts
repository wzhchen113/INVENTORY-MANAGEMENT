// src/utils/poShareText.ts
//
// Spec 108 (D-4) — PURE, framework-free builder for the "Share PO" text body.
// A single purchase order → a clean, message-friendly plain-text string a
// manager pastes into Messages/iMessage or WeChat. Mirrors the
// `src/utils/reorderExport.ts` precedent: no React, no theme, no supabase, no
// i18n import — jest-covered, byte-for-byte.
//
// The ONLY cross-module import is `formatQty` from `./reorderExport` (the
// AC-mandated reuse of the shared quantity formatter). Name resolution is
// INJECTED as a callback (`NameResolver`) so the builder stays pure of the
// store/i18n — the CALLER closes over `inventory` + the active locale and
// resolves each item's current-locale display name via `getLocalizedName`
// (OQ-2), with a per-item English fallback.
//
// NO MONEY enters this builder. `PoShareLine` deliberately omits any cost
// field and this module never imports `formatMoney` — the vendor-facing text
// carries NO dollar amounts anywhere (OQ-1 / AC: the cost basis stays private).
// A jest test asserts the output contains no `$`.
//
// DELIBERATE EXTENSION vs the design's flagged open question (main-Claude
// ruling): the FIXED strings (header brand line, `Store:` / `Date:` labels, and
// the trailing `N items` count) ALSO localize — otherwise a mixed English/中文
// message to a WeChat vendor reads broken (OQ-2 says the WHOLE message follows
// the current app language). The builder stays pure: it takes those strings
// pre-resolved as a `labels` bundle (plain strings, NOT a `t()` import). The
// CALLER resolves them via `T()` in the current app locale and passes them in.

import { formatQty } from './reorderExport';

// One PO line, reduced to exactly what the vendor-facing text needs. NOTE:
// `costPerUnit` / `receivedQty` are intentionally NOT part of this shape — no
// money enters the builder (AC: no `formatMoney` here, no `$` in the output).
// `itemName` is the plain-English `PoLine.itemName` and is carried ONLY as the
// resolver's per-line fallback (OQ-2: English fallback when the current locale
// has no translation AND the caller finds no inventory row) — it is never
// emitted directly; the builder always routes it through `resolveName`.
export interface PoShareLine {
  itemId: string; // = inventory_items.id — the resolver key
  itemName: string; // plain-English fallback name (never emitted verbatim)
  orderedQty: number;
  unit: string;
}

// The PO header fields the text body needs. `referenceDate` is the caller's
// already-sliced `YYYY-MM-DD` string (e.g. `(sel.date || '').slice(0, 10)`).
export interface PoShareInput {
  storeName: string;
  referenceDate: string;
  lines: PoShareLine[];
}

// Pre-resolved, localized FIXED strings (the deliberate extension). The caller
// resolves each via `T()` in the current app locale. Kept as plain strings so
// the builder imports no i18n and stays a pure jest surface.
//
//   header      → the vendor-facing brand/header line (e.g. "I.M.R — Purchase order")
//   storeLabel  → the `Store:` field label (colon-and-space INCLUDED by the caller
//                 is NOT assumed — the builder appends ` ` + storeName, so pass
//                 just the label word, e.g. "Store")
//   dateLabel   → the `Date` field label word (builder appends ` ` + referenceDate)
//   itemsCount  → the already-pluralized/interpolated count string, e.g. "2 items"
//                 (the caller interpolates the raw `lines.length` via T()).
//   noItems     → the empty-body placeholder, e.g. "(no items)".
export interface PoShareLabels {
  header: string;
  storeLabel: string;
  dateLabel: string;
  itemsCount: string;
  noItems: string;
}

// Injected resolver — keeps the builder pure of store/i18n. The CALLER passes
// `(itemId, fallbackName) => getLocalizedName(inventoryRow, locale)` with the
// plain-English `PoLine.itemName` as the fallback when no inventory row is found
// (defensive — a line should always have a matching inventory row).
export type NameResolver = (itemId: string, fallbackName: string) => string;

// Build the shared PO text. Total for any input (empty lines included).
//
// Output template (byte-for-byte — see the jest pin):
//
//   {header}
//   {storeLabel}: {storeName}
//   {dateLabel}: {referenceDate}
//   <blank>
//   {qty} × {unit} {name}      ← one line per PO line, in input order
//   {qty} × {unit} {name}
//   ...
//   <blank>
//   {itemsCount}
//
// The `×` is U+00D7 (multiplication sign), matching the AC's "qty × unit ×
// name" phrasing — pinned exactly in the test. Each body line collapses inner
// whitespace + trims so an empty `unit` never leaves a double space.
//
// Empty-lines edge (AC): when `lines.length === 0`, the body is a single
// `{noItems}` line and the trailing count is the `itemsCount` the caller built
// for a zero count (e.g. "0 items").
export function buildPoShareText(
  input: PoShareInput,
  labels: PoShareLabels,
  resolveName: NameResolver,
): string {
  const out: string[] = [];
  out.push(labels.header);
  out.push(`${labels.storeLabel}: ${input.storeName}`);
  out.push(`${labels.dateLabel}: ${input.referenceDate}`);
  out.push('');

  if (input.lines.length === 0) {
    out.push(labels.noItems);
  } else {
    for (const line of input.lines) {
      const name = resolveName(line.itemId, line.itemName);
      // `{qty} × {unit} {name}` with inner whitespace collapsed + trimmed so a
      // blank unit (or a blank name, defensively) never leaves a double space.
      const body = `${formatQty(line.orderedQty)} × ${line.unit} ${name}`.replace(/\s+/g, ' ').trim();
      out.push(body);
    }
  }

  out.push('');
  out.push(labels.itemsCount);
  return out.join('\n');
}
