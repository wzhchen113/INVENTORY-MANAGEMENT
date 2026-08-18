import { InventoryItem } from '../types';
import { ItemStatus } from '../types';
import { matchesQuery } from '../i18n/matchesQuery';
import type { CountAgeTone } from './countAge';

// Tokens are whitespace-separated. `key:value` (alphanumeric + `-`/`_`) becomes
// an AND-filter on the key; everything else is a case-insensitive substring
// match against `name`. No quoted values, no negatives — keep it minimal.
//
// Filterable keys: status (ok/low/out), cat / category, vendor,
// counted (never/stale — spec 160).
// Anything else falls through to a name match.

interface ParsedFilter {
  text: string[];           // bare tokens — full-text against name
  filters: Array<{ key: 'status' | 'category' | 'vendor' | 'counted'; value: string }>;
}

const KEY_ALIASES: Record<string, ParsedFilter['filters'][number]['key']> = {
  status:   'status',
  cat:      'category',
  category: 'category',
  vendor:   'vendor',
  counted:  'counted',
};

const KV_RE = /^([a-z]+):([\w-]+)$/i;

export function parseFilter(input: string): ParsedFilter {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const text: string[] = [];
  const filters: ParsedFilter['filters'] = [];
  for (const token of tokens) {
    const m = KV_RE.exec(token);
    if (m) {
      const rawKey = m[1].toLowerCase();
      const value = m[2].toLowerCase();
      const mapped = KEY_ALIASES[rawKey];
      if (mapped) {
        filters.push({ key: mapped, value });
        continue;
      }
    }
    text.push(token.toLowerCase());
  }
  return { text, filters };
}

// Test a single inventory item against a parsed filter.
// `getStatus` is delegated to the caller so we don't duplicate the threshold
// logic (currently in useStore.getItemStatus).
//
// Spec 040 P3 — when called via the localized form, bare tokens match the
// English `name` AND the current-locale `i18n_names[locale]` (with
// diacritic + case folding via matchesQuery). The English-only form
// (no `localizedName` candidate) keeps the original byte-substring
// semantics for sites that pre-date P3.
export function matchesFilter(
  item: InventoryItem,
  parsed: ParsedFilter,
  getStatus: (i: InventoryItem) => ItemStatus,
  /** Spec 040 P3 — optional localized display name for bare-token search.
   *  Pass `getLocalizedName(item, locale)` from the call site; the locale
   *  itself isn't needed here because the comparison is string-level. */
  localizedName?: string,
  /** Spec 160 — the row's last-counted tone, precomputed by `countAgeTone` at
   *  the call site. `undefined` = the last-counted aggregate is unavailable on
   *  this surface (still loading, load failed, or the surface never wired it),
   *  which makes every `counted:` token match ZERO rows. Matching every row
   *  instead would re-enter AC-9's failure mode through the filter ("your
   *  entire inventory has never been counted"). */
  countedTone?: CountAgeTone,
): boolean {
  for (const { key, value } of parsed.filters) {
    if (key === 'status') {
      if (getStatus(item) !== value) return false;
    } else if (key === 'category') {
      if ((item.category || '').toLowerCase() !== value) return false;
    } else if (key === 'vendor') {
      const vendor = (item.vendorName || '').toLowerCase();
      if (!vendor.includes(value)) return false;
    } else if (key === 'counted') {
      // AC-15 / AC-16. Exactly two accepted values; anything else matches zero
      // rows (same shape as an unknown `status:` value) rather than falling
      // through to a name search. The thresholds live ONLY in countAge.ts —
      // this branch never sees a day count (AC-17).
      if (countedTone === undefined) return false;
      if (value === 'never') {
        if (countedTone !== 'never') return false;
      } else if (value === 'stale') {
        if (countedTone === 'fresh') return false;
      } else {
        return false;
      }
    }
  }
  if (parsed.text.length > 0) {
    if (localizedName !== undefined) {
      // Localized path — matchesQuery folds diacritics + case across both
      // candidates so the search is symmetric ("detergente" finds
      // "Detergent" when the row is in Spanish mode).
      const candidates: (string | null | undefined)[] = [localizedName, item.name];
      const query = parsed.text.join(' ');
      if (!matchesQuery(query, candidates)) return false;
    } else {
      const haystack = (item.name || '').toLowerCase();
      for (const t of parsed.text) {
        if (!haystack.includes(t)) return false;
      }
    }
  }
  return true;
}
