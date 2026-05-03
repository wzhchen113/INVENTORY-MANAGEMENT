import { InventoryItem } from '../types';
import { ItemStatus } from '../types';

// Tokens are whitespace-separated. `key:value` (alphanumeric + `-`/`_`) becomes
// an AND-filter on the key; everything else is a case-insensitive substring
// match against `name`. No quoted values, no negatives — keep it minimal.
//
// Filterable keys: status (ok/low/out), cat / category, vendor.
// Anything else falls through to a name match.

interface ParsedFilter {
  text: string[];           // bare tokens — full-text against name
  filters: Array<{ key: 'status' | 'category' | 'vendor'; value: string }>;
}

const KEY_ALIASES: Record<string, ParsedFilter['filters'][number]['key']> = {
  status:   'status',
  cat:      'category',
  category: 'category',
  vendor:   'vendor',
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
export function matchesFilter(
  item: InventoryItem,
  parsed: ParsedFilter,
  getStatus: (i: InventoryItem) => ItemStatus,
): boolean {
  for (const { key, value } of parsed.filters) {
    if (key === 'status') {
      if (getStatus(item) !== value) return false;
    } else if (key === 'category') {
      if ((item.category || '').toLowerCase() !== value) return false;
    } else if (key === 'vendor') {
      const vendor = (item.vendorName || '').toLowerCase();
      if (!vendor.includes(value)) return false;
    }
  }
  if (parsed.text.length > 0) {
    const haystack = (item.name || '').toLowerCase();
    for (const t of parsed.text) {
      if (!haystack.includes(t)) return false;
    }
  }
  return true;
}
